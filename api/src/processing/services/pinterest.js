import { genericUserAgent } from "../../config.js";
import { resolveRedirectingURL } from "../url.js";
import { randomBytes } from 'node:crypto';
import HLS from "hls-parser";

const videoRegex = /"url":"(https:\/\/v1\.pinimg\.com\/videos\/.*?)"/g;
const imageRegex = /src="(https:\/\/i\.pinimg\.com\/.*\.(jpg|gif))"/g;
const notFoundRegex = /"__typename"\s*:\s*"PinNotFound"/;

function extractImageFromGraphData(pinData) {
    let bestQuality = pinData["images_orig"];
    if (!bestQuality) {
        for (const key of Object.keys(pinData)) {
            if (!key.startsWith("images_")) continue;
            const image = pinData[key];
            const size = Math.max(image.height, image.width);
            image.size = size;

            if (!bestQuality || size > bestQuality?.size) {
                bestQuality = image;
            }
        }
    }

    const imageType = bestQuality.url?.endsWith(".gif") ? "gif" : "jpg";
    
    if (bestQuality) {
        return {
            urls: bestQuality.url,
            isPhoto: true,
            filename: `pinterest_${pinData.entityId}.${imageType}`
        }
    }
}

async function extractHLSVideoFromGraphData(pinData) {
    const storyPinBlocks = pinData.storyPinData?.pages?.map(page => page.blocks).flat();
    if (!storyPinBlocks) return;

    const videoBlock = storyPinBlocks.find(block => block.__typename === "StoryPinVideoBlock");
    if (!videoBlock) return;

    const videoContent = videoBlock.videoDataV2?.v_hlsv4_video_list?.vHLSV4 ?? videoBlock.videoDataV2?.videoList.vHLSV3MOBILE;
    if (!videoContent) return;

    if (videoContent.url.endsWith(".m3u8")) {
        // hls needs some special treatment to ensure the best quality gets picked
        const hlsManifest = await fetch(videoContent.url).then(r => r.text());
        const parsedHlsManifest = HLS.parse(hlsManifest);

        if (parsedHlsManifest.isMasterPlaylist) {
            const baseUrl = videoContent.url.slice(0, videoContent.url.lastIndexOf("/"));
            const bestVariant = parsedHlsManifest.variants
                .sort((a, b) => b.bandwidth - a.bandwidth)
                .at(0);
            
            if (!bestVariant) return;
            
            const videoUrl = `${baseUrl}/${bestVariant.uri}`;
            const audioUrl = bestVariant.audio?.length > 0 ? `${baseUrl}/${bestVariant.audio[0].uri}` : null;

            return {
                urls: audioUrl ? [videoUrl, audioUrl] : videoUrl,
                isHLS: true,
                filename: `pinterest_${pinData.entityId}.mp4`,
            }
        }
    }

    return {
        urls: videoContent.url,
        filename: `pinterest_${pinData.entityId}.mp4`,
    }
}

export async function fetchFromGraphQL(id) {
    const csrf = randomBytes(16).toString("hex");

    const responseData = await fetch("https://www.pinterest.com/_/graphql/", {
        body: JSON.stringify({
            // "CloseupPageQuery"
            "queryHash": "d25a92975f0946aefd4339969b52bc8224b0033f7c8c78d8a0af2425086d66ff",
            "variables": {
                "pinId": id,
                "isAuth": false,
                "isAuthDesktop": false,
                "isDesktop": true,
                "shouldPrefetchStoryPinFragment": false,
                "shouldSkipImageViewerOnPageQuery": false,
                "isUnauth": true
            }
        }),
        headers: {
            "Content-Type": "application/json",
            "Cookie": `csrftoken=${csrf}`,
            "User-Agent": genericUserAgent,
            "X-Csrftoken": csrf,
        },
        method: "POST",
    }).then(r => r.json());

    if (!responseData.data && responseData.errors) return { error: "fetch.fail" };

    const pinResponse = responseData?.data?.v3GetPinQueryv2;
    if (!pinResponse || pinResponse.__typename !== "PinResponse") {
        return;
    }

    const pinData = pinResponse?.data;
    const video = await extractHLSVideoFromGraphData(pinData);
    if (video) return video;

    const image = extractImageFromGraphData(pinData);
    if (image) return image;
}

// todo: just use the graphql result embedded in the html: see __PWS_RELAY_REGISTER_COMPLETED_REQUEST__


export default async function(o) {
    let id = o.id;

    if (!o.id && o.shortLink) {
        const patternMatch = await resolveRedirectingURL(`https://api.pinterest.com/url_shortener/${o.shortLink}/redirect/`);
        id = patternMatch?.id;
    }

    if (!id) return { error: "fetch.fail" };

    if (id.includes("--")) id = id.split("--")[1];

    const html = await fetch(`https://www.pinterest.com/pin/${id}/`, {
        headers: { "user-agent": genericUserAgent }
    }).then(r => r.text()).catch(() => {});

    if (!html) return { error: "fetch.fail" };

    const invalidPin = html.match(notFoundRegex) && html.includes("<title></title>");

    if (invalidPin) return { error: "fetch.empty" };

    const videoLink = [...html.matchAll(videoRegex)]
                    .map(([, link]) => link)
                    .find(a => a.endsWith('.mp4'));

    if (videoLink) return {
        urls: videoLink,
        filename: `pinterest_${id}.mp4`,
        audioFilename: `pinterest_${id}_audio`
    }

    const imageLink = [...html.matchAll(imageRegex)]
                    .map(([, link]) => link)
                    .find(a => a.endsWith('.jpg') || a.endsWith('.gif'));

    const imageType = imageLink?.endsWith(".gif") ? "gif" : "jpg"

    if (imageLink) return {
        urls: imageLink,
        isPhoto: true,
        filename: `pinterest_${id}.${imageType}`
    }

    const graphResponse = await fetchFromGraphQL(id);
    if (graphResponse) return graphResponse;

    return { error: "fetch.empty" };
}
