import { strict as assert } from "node:assert";
import { once } from "node:events";
import { createServer } from "node:http";
import { PassThrough, Writable } from "node:stream";
import { test } from "node:test";
import { Agent, fetch, MockAgent } from "undici";
import express from "express";

process.env.API_URL = "http://api.example/";
const { env } = await import("../config.js");
const { ffmpegError, logTunnel, tunnelError } = await import("./diagnostics.js");
const { internalStream } = await import("./internal.js");
const { pipe } = await import("./shared.js");
const { default: ffmpeg } = await import("./ffmpeg.js");

function capture(t, enabled = true, onRecord) {
    const previous = env.tunnelDebug;
    env.tunnelDebug = enabled;
    t.after(() => { env.tunnelDebug = previous; });
    const records = [];
    t.mock.method(console, "log", line => {
        const record = JSON.parse(line.slice("[tunnel] ".length));
        records.push(record);
        onRecord?.(record);
    });
    return records;
}

test("diagnostics are opt-in and never serialize URLs, headers or raw errors", t => {
    const records = capture(t, false);
    const info = {
        tunnelId: "test-tunnel", proxyId: "test-proxy", service: "youtube",
        url: "https://user:password@cdn.example/video?sig=secret&pot=token",
        headers: { cookie: "private-cookie" },
    };
    logTunnel("cdn-error", info, { error: new Error(info.url) });
    assert.equal(records.length, 0);
    env.tunnelDebug = true;
    logTunnel("cdn-error", info, {
        error: new TypeError(`Failed ${info.url}`, { cause: { code: "ECONNRESET" } }),
        token: "private-token", url: info.url, status: 403,
    });
    assert.equal(records[0].host, "cdn.example");
    assert.equal(records[0].route, "pinned-proxy");
    assert.equal(records[0].proxyId, "test-proxy");
    assert.equal(records[0].errorName, "TypeError");
    assert.deepEqual(records[0].errorCodes, ["ECONNRESET"]);
    const output = JSON.stringify(records);
    for (const secret of ["password", "private-cookie", "private-token", "secret", "?sig=", "https://"]) {
        assert.ok(!output.includes(secret));
    }
});

test("error summaries handle cyclic causes and categorize FFmpeg without emitting stderr", () => {
    const error = new Error("proxy failed with secret credentials");
    error.code = "UND_ERR_SOCKET";
    error.cause = error;
    assert.deepEqual(tunnelError(error).errorCodes, ["UND_ERR_SOCKET"]);
    const summary = ffmpegError(
        "https://user:password@cdn.example/?sig=secret: Server returned 403 Forbidden\n"
        + "Error opening input files: Invalid data found when processing input\nConversion failed",
    );
    assert.equal(summary.httpStatus, 403);
    assert.deepEqual(summary.reasons, ["invalid-data", "input-open", "conversion"]);
    assert.ok(!JSON.stringify(summary).includes("secret"));
    assert.equal(ffmpegError("").stderrPresent, false);
});

test("pipe diagnostics count bytes without changing output", async t => {
    const records = capture(t);
    const chunks = [];
    const output = new Writable({
        write(chunk, encoding, callback) {
            chunks.push(chunk);
            callback();
        },
    });
    const input = new PassThrough();
    const finished = once(output, "finish");
    pipe(input, output, () => {}, { tunnelId: "test-tunnel" });
    input.end(Buffer.from("video"));
    await finished;
    assert.equal(Buffer.concat(chunks).toString(), "video");
    const ended = records.find(record => record.event === "body-end");
    assert.equal(ended.bytes, 5);
    assert.equal(ended.tunnelId, "test-tunnel");
});

async function chunkServer(t, mock, records) {
    const controller = new AbortController();
    const info = {
        url: "https://cdn.example/video?sig=secret",
        service: "youtube", tunnelId: "test-tunnel", internalId: "test-internal",
        proxyId: "test-proxy", dispatcher: mock, controller,
    };
    const server = createServer((req, res) => internalStream(info, res));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const direct = new Agent();
    t.after(async () => {
        controller.abort();
        await direct.close();
        await mock.close();
        await new Promise(resolve => server.close(resolve));
    });
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { dispatcher: direct });
    const body = await response.text();
    mock.assertNoPendingInterceptors();
    assert.ok(records.every(record => record.tunnelId === "test-tunnel"));
    return body;
}

test("a rejected YouTube HEAD produces correlated status and zero-input diagnostics", async t => {
    const records = capture(t);
    const mock = new MockAgent();
    mock.disableNetConnect();
    mock.get("https://cdn.example").intercept({
        path: "/video?sig=secret", method: "HEAD",
    }).reply(403, "", { headers: { "content-length": "0" } });
    assert.equal(await chunkServer(t, mock, records), "");
    const rejected = records.find(record => record.event === "empty-input");
    assert.equal(rejected.status, 403);
    assert.equal(rejected.contentLength, 0);
    assert.equal(rejected.proxyId, "test-proxy");
    assert.ok(!JSON.stringify(records).includes("secret"));
});

test("YouTube HEAD and chunk GET diagnostics preserve a successful download", async t => {
    const records = capture(t);
    const mock = new MockAgent();
    mock.disableNetConnect();
    const origin = mock.get("https://cdn.example");
    origin.intercept({ path: "/video?sig=secret", method: "HEAD" })
        .reply(200, "", { headers: { "content-length": "5" } });
    origin.intercept({ path: "/video?sig=secret", method: "GET" })
        .reply(206, "video", { headers: { "content-length": "5" } });
    assert.equal(await chunkServer(t, mock, records), "video");
    assert.deepEqual(
        records.filter(record => record.event === "cdn-response").map(record => [record.method, record.status]),
        [["HEAD", 200], ["GET", 206]],
    );
    assert.equal(records.find(record => record.event === "body-end").bytes, 5);
});

test("successful downloads are unchanged with diagnostics disabled", async t => {
    const records = capture(t, false);
    const mock = new MockAgent();
    mock.disableNetConnect();
    const origin = mock.get("https://cdn.example");
    origin.intercept({ path: "/video?sig=secret", method: "HEAD" })
        .reply(200, "", { headers: { "content-length": "5" } });
    origin.intercept({ path: "/video?sig=secret", method: "GET" })
        .reply(206, "video", { headers: { "content-length": "5" } });
    assert.equal(await chunkServer(t, mock, records), "video");
    assert.deepEqual(records, []);
});

test("a real FFmpeg input failure logs its exit and safe stderr categories", { timeout: 15000 }, async t => {
    let resolveExit;
    const exited = new Promise(resolve => { resolveExit = resolve; });
    const records = capture(t, true, record => {
        if (record.event === "ffmpeg-exit") resolveExit(record);
    });
    const previousSystem = env.useSystemFFmpeg;
    const previousPriority = env.processingPriority;
    env.useSystemFFmpeg = false;
    env.processingPriority = false;
    t.after(() => {
        env.useSystemFFmpeg = previousSystem;
        env.processingPriority = previousPriority;
    });
    const app = express();
    app.get("/input", (req, res) => res.type("application/octet-stream").send("not-media"));
    let address;
    app.get("/output", (req, res) => ffmpeg.remux({
        tunnelId: "ffmpeg-test", service: "youtube", type: "remux",
        filename: "video.mp4", urls: `${address}/input?sig=secret`,
    }, res));
    const server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    address = `http://127.0.0.1:${server.address().port}`;
    const direct = new Agent();
    t.after(async () => {
        await direct.close();
        server.closeAllConnections();
        await new Promise(resolve => server.close(resolve));
    });
    const response = await fetch(`${address}/output`, { dispatcher: direct });
    const body = await response.text();
    const exit = await exited;
    assert.equal(response.status, 200);
    assert.equal(body, "");
    assert.ok(exit.code !== 0);
    assert.ok(exit.reasons.includes("invalid-data"), JSON.stringify(records));
    assert.equal(exit.stderrPresent, true);
    assert.ok(records.some(record => record.event === "ffmpeg-start"));
    assert.ok(!JSON.stringify(records).includes("secret"));
});
