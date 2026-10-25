import { resolveRedirectingURL } from "../url.js";
import { genericUserAgent, env } from "../../config.js";
import { getCookie, updateCookieValues } from "../cookie/manager.js";

const GQL_POST_INFO_BY_ID = "029254c4fff5c4ad291436e86b748eba21f70ac9aadb0014d4be6daee9b07255";

let anonymousAccessToken;
async function fetchAnonymousAccessToken({ dispatcher }) {
    if (anonymousAccessToken && anonymousAccessToken?.expiry < Date.now()) {
        return anonymousAccessToken?.token;
    }

    const { access_token, expiry_ts } = await fetch("https://www.reddit.com/auth/v2/oauth/access-token/loid", {
        method: "POST",
        body: JSON.stringify({
            "scopes": ["*", "email", "pii"]
        }),
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Basic " + btoa("ohXpoqrZYub1kg:")
        }
    }).then(r => r.json());

    anonymousAccessToken = {
        token: access_token,
        expiry: expiry_ts - 10_000,
    };

    return anonymousAccessToken?.token;
}

async function getAccessToken() {
    /* "cookie" in cookiefile needs to contain:
     * client_id, client_secret, refresh_token
     * e.g. client_id=bla; client_secret=bla; refresh_token=bla
     *
     * you can get these by making a reddit app and
     * authenticating an account against reddit's oauth2 api
     * see: https://github.com/reddit-archive/reddit/wiki/OAuth2
     *
     * any additional cookie fields are managed by this code and you
     * should not touch them unless you know what you're doing. **/
    const cookie = await getCookie('reddit');
    if (!cookie) return;

    const values = cookie.values(),
          needRefresh = !values.access_token
                        || !values.expiry
                        || Number(values.expiry) < new Date().getTime();
    if (!needRefresh) return values.access_token;

    const data = await fetch('https://www.reddit.com/api/v1/access_token', {
        method: 'POST',
        headers: {
            'authorization': `Basic ${Buffer.from(
                [values.client_id, values.client_secret].join(':')
            ).toString('base64')}`,
            'content-type': 'application/x-www-form-urlencoded',
            'user-agent': genericUserAgent,
            'accept': 'application/json'
        },
        body: `grant_type=refresh_token&refresh_token=${encodeURIComponent(values.refresh_token)}`
    }).then(r => r.json()).catch(() => {});
    if (!data) return;

    const { access_token, refresh_token, expires_in } = data;
    if (!access_token) return;

    updateCookieValues(cookie, {
        ...cookie.values(),
        access_token, refresh_token,
        expiry: new Date().getTime() + (expires_in * 1000),
    });

    return access_token;
}

async function queryGQL(operation, operationHash, variables, accessToken, dispatcher) {
    const response = await fetch("https://gql-fed.reddit.com", {
        method: "POST",
        headers: {
            "User-Agent": genericUserAgent,
            "Content-Type": "application/json",
            "Authorization": `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
            extensions: {
                persistedQuery: {
                    sha256Hash: operationHash,
                    version: 1,
                }
            },
            operationName: operation,
            variables,
        }),
        dispatcher,
    }).then(r => r.json()).catch(() => {});
    if (!response) return;

    return response;
}

async function fetchJsonAPI(params, accessToken, dispatcher) {
    const headers = {
        'user-agent': genericUserAgent,
        authorization: accessToken && `Bearer ${accessToken}`,
        accept: 'application/json',
    };

    const url = new URL(`https://oauth.reddit.com/comments/${params.id}.json`);

    let data = await fetch(url, { 
        headers,
        dispatcher,
    }).then(r => r.json()).catch(() => {});

    if (!data || !Array.isArray(data)) {
        return { error: "fetch.fail" }
    }

    data = data[0]?.data?.children[0]?.data;

    let sourceId;
    if (params.sub || params.user) {
        sourceId = `${String(params.sub || params.user).toLowerCase()}_${params.id}`;
    } else {
        sourceId = params.id;
    }

    if (data?.url?.endsWith('.gif')) return {
        typeId: "redirect",
        urls: data.url,
        filename: `reddit_${sourceId}.gif`,
    }

    if (!data.secure_media?.reddit_video)
        return { error: "fetch.empty" };

    if (data.secure_media?.reddit_video?.duration > env.durationLimit)
        return { error: "content.too_long" };

    const video = data.secure_media?.reddit_video?.fallback_url?.split('?')[0];

    let audio = false,
        audioFileLink = `${data.secure_media?.reddit_video?.fallback_url?.split('DASH')[0]}audio`;

    if (video.match('.mp4')) {
        audioFileLink = `${video.split('_')[0]}_audio.mp4`
    }

    // test the existence of audio
    await fetch(audioFileLink, { method: "HEAD" }).then(r => {
        if (Number(r.status) === 200) {
            audio = true
        }
    }).catch(() => {})

    // fallback for videos with variable audio quality
    if (!audio) {
        audioFileLink = `${video.split('_')[0]}_AUDIO_128.mp4`
        await fetch(audioFileLink, { method: "HEAD" }).then(r => {
            if (Number(r.status) === 200) {
                audio = true
            }
        }).catch(() => {})
    }

    if (!audio) return {
        typeId: "redirect",
        urls: video
    }

    return {
        typeId: "tunnel",
        type: "merge",
        urls: [video, audioFileLink],
        audioFilename: `reddit_${sourceId}_audio`,
        filename: `reddit_${sourceId}.mp4`
    }
}

async function fetchFromGQL(params, accessToken, dispatcher) {
    const downloadName = params.sub || params.user ? `${String(params.sub || params.user).toLowerCase()}_${params.id}` : params.id;

    // user posts are prefixed with t2, the ones on subreddits are prefixed with t3_
    const gqlPrefix = params.user ? "t2_" : "t3_";
    const data = await queryGQL("PostInfoById", GQL_POST_INFO_BY_ID, {
        id: gqlPrefix + params.id,
    }, accessToken, dispatcher);

    const postData = data?.data?.postInfoById;
    if (!postData) return { error: "fetch.empty" };

    // check for videos
    if (postData.media?.typeHint === "VIDEO") {
        // there's 3 relevant types of media we can check for here:
        // - packagedMedia, seems to have the highest quality media AND is just a regular mp4 file
        // - download, 720p only? shouldn't bother tbh, but at least its premerged
        // - streaming, regular hls, i guess its usable but hls is my mortal enemy
        if (postData.media.packagedMedia?.muxedMp4s) {
            let pm = postData.media.packagedMedia.muxedMp4s;
            const highestQuality = pm.highest ?? pm.high ?? pm.medium ?? pm.low;        
            if (highestQuality?.url) {
                if (highestQuality?.duration > env.durationLimit) return { error: "content.too_long" };
                return {
                    typeId: "redirect",
                    urls: highestQuality.url,
                    filename: `reddit_${downloadName}.mp4`,
                };
            }
        }

        if (postData.media.streaming?.hlsUrl) {
            if (postData.media.streaming.duration > env.durationLimit) return { error: "content.too_long" };

            return {
                urls: postData.media.streaming.hlsUrl,
                isHLS: true,
                filename: `reddit_${downloadName}.mp4`,
            };
        }
    }

    // sometimes posts themselves can be "deleted", but their videos are still there
    if (postData.url?.startsWith("https://v.redd.it/")) {
        // gql sadly doesn't give us a media url in this case, so.. we'll need to try a few resolutions
        let videoUrl;
        for (const res of [ 1080, 720, 480, 360 ]) {
            const response = await fetch(`${postData.url}/DASH_${res}.mp4`, { method: "HEAD", dispatcher });
            if (response.ok) {
                videoUrl = response.url;
                break;
            }
        }

        if (!videoUrl) return { error: "fetch.empty" };
        
        let audioUrl;
        let audioProbe = await fetch(postData.url + "/DASH_audio.mp4", { method: "HEAD", dispatcher });
        if (audioProbe.ok) {
            audioUrl = audioProbe.url;
        }

        return {
            typeId: "tunnel",
            type: "merge",
            urls: audioUrl ? [videoUrl, audioUrl] : videoUrl,
            audioFilename: `reddit_${downloadName}_audio`,
            filename: `reddit_${downloadName}.mp4`,
        };
    }

    // gifs
    if (postData.url?.startsWith("https://i.redd.it") && postData.url?.endsWith(".gif")) {
        return {
            typeId: "redirect",
            urls: postData.url,
            filename: `reddit_${downloadName}.gif`
        }
    }

    if (postData.media?.typeHint == "GIFVIDEO" && postData.media.animated) {
        const pm = postData.media.animated;
        const bestQuality = pm.mp4_source ?? pm.mp4_xxxlarge ?? pm.mp4_xxlarge ?? pm.mp4_xlarge 
            ?? pm.mp4_large ?? pm.mp4_medium ?? pm.mp4_small;
        
        if (bestQuality.url) {
            return {
                typeId: "redirect",
                urls: bestQuality.url,
                filename: `reddit_${downloadName}.gif`
            }
        }
    }

    return { error: "fetch.empty" };
}

export default async function(obj) {
    let params = obj;

    const accessToken = await getAccessToken();
    const anonymousAccessToken = accessToken || await fetchAnonymousAccessToken({
        dispatcher: obj.dispatcher,
    });

    const resolvingHeaders = {
        "User-Agent": genericUserAgent,
        "Authorization": `Bearer ${anonymousAccessToken}`,
    };

    if (params.shortId) {
        params = await resolveRedirectingURL(
            `https://www.reddit.com/video/${params.shortId}`,
            obj.dispatcher, resolvingHeaders
        );
    }

    if (!params.id && params.shareId) {
        params = await resolveRedirectingURL(
            `https://www.reddit.com/r/${params.sub}/s/${params.shareId}`,
            obj.dispatcher, resolvingHeaders
        );
    }

    if (!params?.id) return { error: "fetch.short_link" };
    
    if (accessToken) return fetchJsonAPI(params, accessToken, obj.dispatcher);
    else return fetchFromGQL(params, anonymousAccessToken, obj.dispatcher);
}
