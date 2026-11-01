import { env } from "../config.js";

const safeLabel = value => typeof value === "string" && /^[\w.-]{1,100}$/.test(value)
    ? value : undefined;
const detailKeys = new Set([
    "status", "bytes", "reason", "result", "method", "attempt", "offset",
    "contentLength", "expected", "received", "aborted", "ended", "finished",
    "code", "signal", "childPid", "inputs", "system", "reasons", "httpStatus",
    "stderrPresent", "playerId", "signatureTimestamp", "poTokenPresent",
    "shutdownRequested",
]);

export function tunnelError(error) {
    const names = new Set([
        "Error", "TypeError", "RangeError", "SyntaxError", "AbortError",
        "TimeoutError", "PlayerError", "RequestAbortedError", "SocketError",
    ]);
    const codes = [];
    const seen = new Set();
    for (let cause = error; cause && !seen.has(cause) && seen.size < 8; cause = cause.cause) {
        seen.add(cause);
        if (typeof cause.code === "string" && /^(?:E[A-Z0-9_]{1,60}|UND_ERR_[A-Z0-9_]{1,60})$/.test(cause.code)) {
            codes.push(cause.code);
        }
    }
    const message = typeof error?.message === "string" ? error.message : "";
    const reason = error === "no_session_tokens" ? "no-session-tokens"
        : /decipher|nsig|signature/i.test(message) ? "decipher"
        : /timed? ?out|timeout/i.test(message) ? "timeout"
        : /abort/i.test(message) ? "aborted"
        : /proxy/i.test(message) ? "proxy"
        : undefined;
    return {
        errorName: names.has(error?.name) ? error.name : "Error",
        errorCodes: codes,
        errorReason: reason,
    };
}

export function ffmpegError(stderr) {
    const patterns = [
        ["invalid-data", /Invalid data found when processing input/i],
        ["input-open", /Error opening input|Error opening input files/i],
        ["connection-refused", /Connection refused/i],
        ["timeout", /Connection timed out|Connection timeout/i],
        ["dns", /Failed to resolve hostname|Name or service not known/i],
        ["tls", /TLS|certificate verify failed/i],
        ["missing-codec", /Unknown decoder|Unknown encoder|Decoder .* not found|Encoder .* not found/i],
        ["missing-stream", /matches no streams|does not contain any stream/i],
        ["output-header", /Could not write header/i],
        ["permission", /Permission denied|Operation not permitted/i],
        ["missing-file", /No such file or directory/i],
        ["disk-full", /No space left on device/i],
        ["io", /Input\/output error/i],
        ["conversion", /Conversion failed/i],
    ];
    return {
        reasons: patterns.filter(([, pattern]) => pattern.test(stderr)).map(([reason]) => reason),
        httpStatus: Number(/HTTP error (\d{3})|Server returned (\d{3})/i.exec(stderr)?.slice(1).find(Boolean)) || undefined,
        stderrPresent: !!stderr,
    };
}

export function logTunnel(event, info = {}, details = {}) {
    if (!env.tunnelDebug) return;

    const host = typeof info.url === "string" && URL.canParse(info.url)
        ? new URL(info.url).hostname : undefined;
    const fields = {
        time: new Date().toISOString(),
        pid: process.pid,
        event: safeLabel(event),
        tunnelId: safeLabel(info.tunnelId),
        internalId: safeLabel(info.internalId),
        service: safeLabel(info.service),
        type: safeLabel(info.type),
        proxyId: safeLabel(info.proxyId),
        route: info.proxyId ? "pinned-proxy"
            : info.requestIP ? "freebind"
            : info.dispatcher ? "custom-dispatcher" : "environment",
        host,
        client: safeLabel(info.originalRequest?.innertubeClient),
    };
    for (const [key, value] of Object.entries(details)) {
        if (key === "error") {
            Object.assign(fields, tunnelError(value));
        } else if (!detailKeys.has(key)) {
            continue;
        } else if (typeof value === "number" || typeof value === "boolean") {
            fields[key] = Number.isNaN(value) ? undefined : value;
        } else if (Array.isArray(value)) {
            fields[key] = value.map(safeLabel).filter(Boolean);
        } else {
            fields[key] = safeLabel(value);
        }
    }
    console.log(`[tunnel] ${JSON.stringify(fields)}`);
}
