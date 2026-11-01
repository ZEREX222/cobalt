import Store from "../store/store.js";

import { nanoid } from "nanoid";
import { randomBytes } from "crypto";
import { strict as assert } from "assert";
import { setMaxListeners } from "node:events";

import { env } from "../config.js";
import { closeRequest } from "./shared.js";
import { decryptStream, encryptStream } from "../misc/crypto.js";
import { hashHmac } from "../security/secrets.js";
import { zip } from "../misc/utils.js";
import { currentProxy } from "../misc/proxy-pool.js";
import { pinnedProxyDispatcher, withPinnedProxy } from "../misc/proxy.js";
import { logTunnel } from "./diagnostics.js";

// optional dependency
const freebind = env.freebindCIDR && await import('freebind').catch(() => {});

const streamCache = new Store('streams');

const internalStreamCache = new Map();
const proxyEpisodes = new Map();

export function createStream(obj) {
    currentProxy()?.controller.signal.throwIfAborted();
    const streamID = nanoid(),
        iv = randomBytes(16).toString('base64url'),
        secret = randomBytes(32).toString('base64url'),
        exp = new Date().getTime() + env.streamLifespan * 1000,
        hmac = hashHmac(`${streamID},${exp},${iv},${secret}`, 'stream').toString('base64url'),
        streamData = {
            tunnelId: streamID,
            exp: exp,
            type: obj.type,
            urls: obj.url,
            service: obj.service,
            filename: obj.filename,

            requestIP: obj.requestIP,
            proxyId: obj.proxyId || currentProxy()?.id,
            proxyService: obj.proxyService || currentProxy()?.service,
            headers: obj.headers,

            metadata: obj.fileMetadata || false,
            cover: obj.cover,
            cropCover: obj.cropCover || false,

            audioBitrate: obj.audioBitrate,
            audioCopy: !!obj.audioCopy,
            audioFormat: obj.audioFormat,

            isHLS: obj.isHLS || false,
            originalRequest: obj.originalRequest,

            // url to a subtitle file
            subtitles: obj.subtitles,
        };

    // FIXME: this is now a Promise, but it is not awaited
    //        here. it may happen that the stream is not
    //        stored in the Store before it is requested.
    streamCache.set(
        streamID,
        encryptStream(streamData, iv, secret),
        env.streamLifespan
    );
    logTunnel("created", streamData);

    let streamLink = new URL('/tunnel/'+encodeURIComponent(obj.filename), env.apiURL);

    const params = {
        'id': streamID,
        'exp': exp,
        'sig': hmac,
        'sec': secret,
        'iv': iv
    }

    for (const [key, value] of Object.entries(params)) {
        streamLink.searchParams.append(key, value);
    }

    return streamLink.toString();
}

export function createProxyTunnels(info) {
    const proxyTunnels = [];

    let urls = info.url;

    if (typeof urls === "string") {
        urls = [urls];
    }

    const tunnelTemplate = {
        type: "proxy",
        headers: info?.headers,
        requestIP: info?.requestIP,
    }

    for (const url of urls) {
        proxyTunnels.push(
            createStream({
                ...tunnelTemplate,
                url,
                service: info?.service,
                originalRequest: info?.originalRequest,
            })
        );
    }

    if (info.subtitles) {
        proxyTunnels.push(
            createStream({
                ...tunnelTemplate,
                url: info.subtitles,
                service: `${info?.service}-subtitles`,
            })
        );
    }

    if (info.cover) {
        proxyTunnels.push(
            createStream({
                ...tunnelTemplate,
                url: info.cover,
                service: `${info?.service}-cover`,
            })
        );
    }

    return proxyTunnels;
}

export function getInternalTunnel(id) {
    return internalStreamCache.get(id);
}

export function getInternalTunnelFromURL(url) {
    url = new URL(url);
    if (url.hostname !== '127.0.0.1') {
        return;
    }

    const id = url.searchParams.get('id');
    return getInternalTunnel(id);
}

export function createInternalStream(url, obj = {}, isSpecial) {
    currentProxy()?.controller.signal.throwIfAborted();
    assert(typeof url === 'string');

    let dispatcher = obj.dispatcher;
    const proxyId = obj.proxyId || currentProxy()?.id;
    const proxyService = obj.proxyService || currentProxy()?.service || obj.service;
    if (proxyId && new URL(url).hostname !== '127.0.0.1') {
        dispatcher = pinnedProxyDispatcher(proxyId, proxyService, obj.proxyEpisode);
    }
    if (obj.requestIP) {
        dispatcher = freebind?.dispatcherFromIP(obj.requestIP, { strict: false })
    }

    const streamID = nanoid();
    let controller = obj.controller;

    if (!controller) {
        controller = new AbortController();
        setMaxListeners(Infinity, controller.signal);
    }

    let headers;
    if (obj.headers) {
        headers = new Map(Object.entries(obj.headers));
    }

    // subtitles & covers don't need special treatment unlike big media files
    const service = isSpecial ? `${obj.service}-special` : obj.service;

    internalStreamCache.set(streamID, {
        url,
        service,
        headers,
        controller,
        dispatcher,
        proxyId,
        proxyService,
        isHLS: obj.isHLS,
        transplant: obj.transplant,
        tunnelId: obj.tunnelId,
        internalId: streamID,
        proxyEpisode: obj.proxyEpisode,
        requestIP: obj.requestIP,
    });
    logTunnel("internal-created", internalStreamCache.get(streamID));

    let streamLink = new URL('/itunnel', `http://127.0.0.1:${env.tunnelPort}`);
    streamLink.searchParams.set('id', streamID);

    const cleanup = () => {
        destroyInternalStream(streamLink);
        controller.signal.removeEventListener('abort', cleanup);
    }

    controller.signal.addEventListener('abort', cleanup);
    currentProxy()?.cleanups.push(cleanup);

    return streamLink.toString();
}

function getInternalTunnelId(url) {
    url = new URL(url);
    if (url.hostname !== '127.0.0.1') {
        return;
    }

    return url.searchParams.get('id');
}

export function destroyInternalStream(url) {
    const id = getInternalTunnelId(url);

    if (internalStreamCache.has(id)) {
        closeRequest(getInternalTunnel(id)?.controller);
        internalStreamCache.delete(id);
    }
}

const transplantInternalTunnels = function(tunnelUrls, transplantUrls) {
    if (tunnelUrls.length !== transplantUrls.length) {
        return;
    }

    for (const [ tun, url ] of zip(tunnelUrls, transplantUrls)) {
        const id = getInternalTunnelId(tun);
        const itunnel = getInternalTunnel(id);

        if (!itunnel) continue;
        itunnel.url = url;
    }
}

const transplantTunnel = async function (dispatcher) {
    if (this.pendingTransplant) {
        await this.pendingTransplant;
        return;
    }

    let finished;
    this.pendingTransplant = new Promise(r => finished = r);

    try {
        logTunnel("refresh-start", this);
        const handler = await import(`../processing/services/${this.service}.js`);
        const response = await withPinnedProxy(
            this.proxyId, this.proxyService || this.service,
            () => handler.default({ ...this.originalRequest, dispatcher }),
        );

        if (!response.urls) {
            logTunnel("refresh-failed", this, {
                reason: "no-urls", result: response.error,
            });
            return;
        }

        response.urls = [response.urls].flat();
        if (this.originalRequest.isAudioOnly && response.urls.length > 1) {
            response.urls = [response.urls[1]];
        } else if (this.originalRequest.isAudioMuted) {
            response.urls = [response.urls[0]];
        }

        const tunnels = [this.urls].flat();
        if (tunnels.length !== response.urls.length) {
            logTunnel("refresh-failed", this, { reason: "url-count-mismatch" });
            return;
        }

        transplantInternalTunnels(tunnels, response.urls);
        logTunnel("refresh-complete", this);
    }
    catch (error) {
        logTunnel("refresh-error", this, { error });
    }
    finally {
        finished();
        delete this.pendingTransplant;
    }
}

function wrapStream(streamInfo) {
    const url = streamInfo.urls;
    streamInfo.proxyEpisode = new Set();
    if (streamInfo.proxyId) {
        if (!proxyEpisodes.has(streamInfo.tunnelId)) {
            for (const [id, episode] of proxyEpisodes) {
                if (episode.exp <= Date.now()) proxyEpisodes.delete(id);
            }
            if (proxyEpisodes.size >= 1024) proxyEpisodes.delete(proxyEpisodes.keys().next().value);
            proxyEpisodes.set(streamInfo.tunnelId, {
                failures: streamInfo.proxyEpisode, exp: streamInfo.exp,
            });
        }
        streamInfo.proxyEpisode = proxyEpisodes.get(streamInfo.tunnelId).failures;
    }

    if (streamInfo.originalRequest) {
        streamInfo.transplant = transplantTunnel.bind(streamInfo);
    }

    if (typeof url === 'string') {
        streamInfo.urls = createInternalStream(url, streamInfo);
    } else if (Array.isArray(url)) {
        for (const idx in streamInfo.urls) {
            streamInfo.urls[idx] = createInternalStream(
                streamInfo.urls[idx], streamInfo
            );
        }
    } else throw 'invalid urls';

    if (streamInfo.subtitles) {
        streamInfo.subtitles = createInternalStream(
            streamInfo.subtitles,
            streamInfo,
            /*isSpecial=*/true
        );
    }

    if (streamInfo.cover) {
        streamInfo.cover = createInternalStream(
            streamInfo.cover,
            streamInfo,
            /*isSpecial*/true,
        )
    }

    return streamInfo;
}

export async function verifyStream(id, hmac, exp, secret, iv) {
    try {
        const ghmac = hashHmac(`${id},${exp},${iv},${secret}`, 'stream').toString('base64url');
        const cache = await streamCache.get(id.toString());

        if (ghmac !== String(hmac)) {
            logTunnel("verify-rejected", { tunnelId: id }, { status: 401, reason: "invalid-signature" });
            return { status: 401 };
        }
        if (!cache) {
            logTunnel("verify-rejected", { tunnelId: id }, { status: 404, reason: "cache-miss" });
            return { status: 404 };
        }

        const streamInfo = JSON.parse(decryptStream(cache, iv, secret));

        if (!streamInfo) {
            logTunnel("verify-rejected", { tunnelId: id }, { status: 404, reason: "invalid-stream" });
            return { status: 404 };
        }

        if (Number(exp) <= new Date().getTime()) {
            logTunnel("verify-rejected", { tunnelId: id }, { status: 404, reason: "expired" });
            return { status: 404 };
        }

        streamInfo.tunnelId = id;
        return wrapStream(streamInfo);
    }
    catch (error) {
        logTunnel("verify-error", { tunnelId: id }, { error });
        return { status: 500 };
    }
}
