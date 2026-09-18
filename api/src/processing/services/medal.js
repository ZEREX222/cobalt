import { genericUserAgent, env } from "../../config.js";

const videoDataRegex = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/i;

export default async function(o) {
    let html = await fetch(`https://medal.tv/games/${o.game}/clips/${o.id}`, {
        headers: { "user-agent": genericUserAgent }
    }).then(r => r.text()).catch(() => {});

    if (!html) return { error: "fetch.fail" };
    const match = html.match(videoDataRegex);
    if (!match) return { error: "fetch.fail" };

    const data = JSON.parse(match[1]);
    const videoUrl = data.contentUrl;

    return {
        urls: videoUrl,
        filename: `medal_${o.id}.mp4`,
        audioFilename: `medal_${o.id}_audio`
    }
}
