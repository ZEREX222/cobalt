import stream from "../stream/stream.js";
import { getInternalTunnel } from "../stream/manage.js";
import { setTunnelPort } from "../config.js";
import { Green } from "../misc/console-text.js";
import express from "express";
import { logTunnel } from "../stream/diagnostics.js";

const validateTunnel = (req, res) => {
    if (!req.ip.endsWith('127.0.0.1')) {
        logTunnel("internal-rejected", {}, { status: 403, reason: "non-loopback" });
        res.sendStatus(403);
        return;
    }

    if (String(req.query.id).length !== 21) {
        logTunnel("internal-rejected", {}, { status: 400, reason: "invalid-query" });
        res.sendStatus(400);
        return;
    }

    const streamInfo = getInternalTunnel(req.query.id);
    if (!streamInfo) {
        logTunnel("internal-rejected", { internalId: req.query.id }, {
            status: 404, reason: "cache-miss",
        });
        res.sendStatus(404);
        return;
    }

    return streamInfo;
}

const streamTunnel = (req, res) => {
    const streamInfo = validateTunnel(req, res);
    if (!streamInfo) {
        return;
    }

    streamInfo.headers = new Map([
        ...(streamInfo.headers || []),
        ...Object.entries(req.headers)
    ]);

    return stream(res, { type: 'internal', data: streamInfo });
}

export const setupTunnelHandler = () => {
    const tunnelHandler = express();

    tunnelHandler.get('/itunnel', streamTunnel);

    // fallback
    tunnelHandler.use((_, res) => res.sendStatus(400));
    // error handler
    tunnelHandler.use((error, req, res, next) => {
        logTunnel("internal-error", { internalId: req.query.id }, { error });
        res.socket.end();
    });


    const server = tunnelHandler.listen({
        port: 0,
        host: '127.0.0.1',
        exclusive: true
    }, () => {
        const { port } = server.address();
        console.log(`${Green('[✓]')} internal tunnel handler running on 127.0.0.1:${port}`);
        setTunnelPort(port);
    });
}
