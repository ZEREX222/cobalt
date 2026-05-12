import HLS from "hls-parser";
import { genericUserAgent } from "../../config.js";

const preferPremerged = (url) =>
    url.replace(/-split\.m3u8(\?|$)/, ".m3u8$1");

const appendQueryToUrl = (baseUrl, targetUrl) => {
    const base = new URL(baseUrl);
    const target = new URL(targetUrl, baseUrl);

    if (!target.search && base.search) {
        target.search = base.search;
    }
    return target.toString();
};

function craftHeaders(operationName) {
    return {
        "user-agent": genericUserAgent,
        "content-type": "application/json",
        accept: "application/json",
        origin: "https://www.loom.com",
        "x-loom-request-source": "loom_web_45a5bd4",
        "apollographql-client-name": "web",
        "apollographql-client-version": "45a5bd4",
        "graphql-operation-name": operationName,
    };
}

async function getSession(videoId, endpoint) {
    const res = await fetch(`https://www.loom.com/api/campaigns/sessions/${videoId}/${endpoint}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "accept": "application/json",
        "origin": "https://www.loom.com",
        "user-agent": genericUserAgent,
      },
      body: JSON.stringify({
        anonID: crypto.randomUUID(),
        force_original: false,
      }),
    }
  )
  .then(r => r.status === 200 && r.json())
  .catch(() => {});

  return res;
}

async function getVideo({ cdnUrl, dispatcher }) {
    if (!cdnUrl.includes("/resource/hls/") || (!cdnUrl.includes(".m3u8"))) {
        return { error: "fetch.empty" };
    }

    const candidates = [preferPremerged(cdnUrl), cdnUrl];

    let masterText = null;
    let cdnUrlUsed = null;

    for (const u of candidates) {
        const txt = await fetch(u, { dispatcher })
        .then(r => (r.status === 200 ? r.text() : null))
        .catch(() => null);
        if (txt) {
        masterText = txt;
        cdnUrlUsed = u;
        break;
        }
    }

    if (!masterText) return { error: "fetch.empty" };

    const parsed = HLS.parse(masterText);
    if (!parsed) return { error: "fetch.empty" };

    const bestVariant = parsed?.variants?.reduce(
        (a, b) => (a?.bandwidth > b?.bandwidth ? a : b),
        null
    );

    if (!bestVariant?.uri) return { error: "fetch.empty" };

    const videoURL = appendQueryToUrl(cdnUrlUsed, new URL(bestVariant.uri, cdnUrlUsed).toString());

    const audioRenditions =
        parsed?.audios ??
        parsed?.renditions?.audios ??
        [];

    const chosenAudio =
        audioRenditions.find(a => a.default) ??
        audioRenditions[0] ??
        null;

    const audioURL = chosenAudio?.uri
        ? appendQueryToUrl(cdnUrlUsed, new URL(chosenAudio.uri, cdnUrlUsed).toString())
        : null;

    return {
        url: videoURL,
        audioUrl: audioURL
    };
}


async function getTranscript(id) {
    const gql = await fetch(`https://www.loom.com/graphql`, {
        method: "POST",
        headers: craftHeaders("FetchVideoTranscriptForFetchTranscript"),
        body: JSON.stringify({
            operationName: "FetchVideoTranscriptForFetchTranscript",
            variables: {
                videoId: id,
                password: null,
            },
            query: `
                query FetchVideoTranscriptForFetchTranscript($videoId: ID!, $password: String) {
                    fetchVideoTranscript(videoId: $videoId, password: $password) {
                        ... on VideoTranscriptDetails {
                        captions_source_url
                        language
                        __typename
                        }
                        ... on GenericError {
                        message
                        __typename
                        }
                        __typename
                    }
                }`,
        })
    })
    .then(r => r.status === 200 && r.json())
    .catch(() => {});

    if (gql?.data?.fetchVideoTranscript?.captions_source_url?.includes('.vtt?')) {
        return gql.data.fetchVideoTranscript.captions_source_url;
    }
}

export default async function({ id, subtitleLang, dispatcher }) {
    let videoSession = await getSession(id, "raw-url");
    videoSession ??= await getSession(id, "transcoded-url");

    if (!videoSession.url) {
        return { error: "fetch.empty" }
    }

    let subtitles;
    if (subtitleLang) {
        const transcript = await getTranscript(id);
        if (transcript) subtitles = transcript;
    }

    let videoData = await getVideo({ cdnUrl: videoSession.url, dispatcher });

    return {
        urls: videoData.url,
        audioUrls: videoData.audioUrl,
        subtitles,
        filename: `loom_${id}.mp4`,
        audioFilename: `loom_${id}_audio`,
        isHLS: true,
    }
}