import { request } from "undici";
import { Readable } from "node:stream";
import { closeRequest, getHeaders, pipe } from "./shared.js";
import { handleHlsPlaylist, isHlsResponse, probeInternalHLSTunnel } from "./internal-hls.js";
import { logTunnel } from "./diagnostics.js";

const CHUNK_SIZE = BigInt(8e6); // 8 MB
const min = (a, b) => a < b ? a : b;

const serviceNeedsChunks = new Set(["youtube", "vk"]);

async function* readChunks(streamInfo, size) {
    let read = 0n, chunksSinceTransplant = 0;
    while (read < size) {
        if (streamInfo.controller.signal.aborted) {
            throw new Error("controller aborted");
        }

        logTunnel("cdn-request", streamInfo, { method: "GET", offset: Number(read) });
        const chunk = await request(streamInfo.url, {
            headers: {
                ...getHeaders(streamInfo.service),
                Range: `bytes=${read}-${read + CHUNK_SIZE}`
            },
            dispatcher: streamInfo.dispatcher,
            signal: streamInfo.controller.signal,
            maxRedirections: 4
        });
        logTunnel("cdn-response", streamInfo, {
            method: "GET", status: chunk.statusCode, offset: Number(read),
            contentLength: Number(chunk.headers["content-length"]),
        });

        if (chunk.statusCode === 403 && chunksSinceTransplant >= 3 && streamInfo.transplant) {
            chunksSinceTransplant = 0;
            try {
                await streamInfo.transplant(streamInfo.dispatcher);
                continue;
            } catch {}
        }

        chunksSinceTransplant++;

        const expected = min(CHUNK_SIZE, size - read);
        const received = BigInt(chunk.headers['content-length']);

        if (received < expected / 2n) {
            logTunnel("short-chunk", streamInfo, {
                expected: Number(expected), received: Number(received),
            });
            closeRequest(streamInfo.controller);
        }

        for await (const data of chunk.body) {
            yield data;
        }

        read += received;
    }
}

async function handleChunkedStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => (res.end(), closeRequest(streamInfo.controller));

    try {
        let req, attempts = 3;
        while (attempts--) {
            logTunnel("cdn-request", streamInfo, { method: "HEAD", attempt: 3 - attempts });
            req = await fetch(streamInfo.url, {
                headers: getHeaders(streamInfo.service),
                method: 'HEAD',
                dispatcher: streamInfo.dispatcher,
                signal
            });
            logTunnel("cdn-response", streamInfo, {
                method: "HEAD", status: req.status,
                contentLength: Number(req.headers.get("content-length")),
            });

            streamInfo.url = req.url;
            if (req.status === 403 && streamInfo.transplant) {
                try {
                    await streamInfo.transplant(streamInfo.dispatcher);
                } catch {
                    break;
                }
            } else break;
        }

        const size = BigInt(req.headers.get('content-length'));

        if (req.status !== 200 || !size) {
            logTunnel("empty-input", streamInfo, {
                status: req.status, contentLength: Number(size),
            });
            globalThis.FORCE_RESET_INNERTUBE_PLAYER = true;
            return cleanup();
        }

        const generator = readChunks(streamInfo, size);

        const abortGenerator = () => {
            generator.return();
            signal.removeEventListener('abort', abortGenerator);
        }

        signal.addEventListener('abort', abortGenerator);

        const stream = Readable.from(generator);

        for (const headerName of ['content-type', 'content-length']) {
            const headerValue = req.headers.get(headerName);
            if (headerValue) res.setHeader(headerName, headerValue);
        }

        pipe(stream, res, cleanup, streamInfo);
    } catch (error) {
        logTunnel("cdn-error", streamInfo, { error, aborted: signal.aborted });
        cleanup();
    }
}

async function handleGenericStream(streamInfo, res) {
    const { signal } = streamInfo.controller;
    const cleanup = () => res.end();

    try {
        logTunnel("cdn-request", streamInfo, { method: "GET" });
        const fileResponse = await request(streamInfo.url, {
            headers: {
                ...getHeaders(streamInfo.service),
                ...Object.fromEntries(streamInfo.headers),
                host: undefined
            },
            dispatcher: streamInfo.dispatcher,
            signal,
            maxRedirections: 16
        });
        logTunnel("cdn-response", streamInfo, {
            method: "GET", status: fileResponse.statusCode,
            contentLength: Number(fileResponse.headers["content-length"]),
        });

        res.status(fileResponse.statusCode);
        fileResponse.body.on('error', () => {});

        const isHls = isHlsResponse(fileResponse, streamInfo);

        for (const [ name, value ] of Object.entries(fileResponse.headers)) {
            if (!isHls || name.toLowerCase() !== 'content-length') {
                res.setHeader(name, value);
            }
        }

        if (fileResponse.statusCode < 200 || fileResponse.statusCode > 299) {
            logTunnel("input-rejected", streamInfo, { status: fileResponse.statusCode });
            return cleanup();
        }

        if (isHls) {
            res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
            await handleHlsPlaylist(streamInfo, fileResponse, res);
        } else {
            pipe(fileResponse.body, res, cleanup, streamInfo);
        }
    } catch (error) {
        logTunnel("cdn-error", streamInfo, { error, aborted: signal.aborted });
        closeRequest(streamInfo.controller);
        cleanup();
    }
}

export function internalStream(streamInfo, res) {
    if (streamInfo.headers) {
        streamInfo.headers.delete('icy-metadata');
    }

    if (serviceNeedsChunks.has(streamInfo.service) && !streamInfo.isHLS) {
        return handleChunkedStream(streamInfo, res);
    }

    return handleGenericStream(streamInfo, res);
}

export async function probeInternalTunnel(streamInfo) {
    try {
        const signal = AbortSignal.timeout(3000);
        logTunnel("estimate-start", streamInfo, { method: "HEAD" });
        const headers = {
            ...Object.fromEntries(streamInfo.headers || []),
            ...getHeaders(streamInfo.service),
            host: undefined,
            range: undefined
        };

        if (streamInfo.isHLS) {
            return probeInternalHLSTunnel({
                ...streamInfo,
                signal,
                headers
            });
        }

        const response = await request(streamInfo.url, {
            method: 'HEAD',
            headers,
            dispatcher: streamInfo.dispatcher,
            signal,
            maxRedirections: 16
        });
        logTunnel("estimate-response", streamInfo, {
            status: response.statusCode,
            contentLength: Number(response.headers["content-length"]),
        });

        if (response.statusCode !== 200)
            throw "status is not 200 OK";

        const size = +response.headers['content-length'];
        if (isNaN(size))
            throw "content-length is not a number";

        return size;
    } catch (error) {
        logTunnel("estimate-error", streamInfo, { error });
    }
}
