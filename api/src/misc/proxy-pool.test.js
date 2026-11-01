import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import {
    Agent, fetch, getGlobalDispatcher, MockAgent, setGlobalDispatcher,
} from "undici";
import {
    currentProxy, parseProxyPool, ProxyPool, ProxyRouter,
} from "./proxy-pool.js";

const success = { status: 200, body: { status: "tunnel" } };
const failure = (code = "fetch.fail") => ({
    status: 400, body: { status: "error", error: { code: `error.api.${code}` } },
});
const urls = ["http://proxy-a:3128", "http://proxy-b:3128", "http://proxy-c:3128"];

function fixture(t, options = {}) {
    let time = 100000;
    const agents = [];
    const pool = new ProxyPool(urls, {
        now: () => time, random: () => 0.5, log: () => {},
        agentFactory: () => {
            const agent = new MockAgent();
            agent.disableNetConnect();
            agents.push(agent);
            return agent;
        },
        ...options,
    });
    t.after(() => pool.close());
    return { pool, agents, advance: ms => time += ms };
}

test("parses a Docker-friendly list, normalizes and deduplicates URLs", () => {
    assert.deepEqual(parseProxyPool(" http://user:p%40ss@proxy-a:3128,\nhttps://proxy-b:443 http://user:p%40ss@proxy-a:3128 "), [
        "http://user:p%40ss@proxy-a:3128/", "https://proxy-b/",
    ]);
    assert.deepEqual(parseProxyPool(""), []);
    for (const invalid of ["secret-value", "socks5://proxy:1080", "http://proxy/path", "http://proxy/?token=secret"]) {
        assert.throws(() => parseProxyPool(invalid), error =>
            error.message.startsWith("PROXY_POOL:") && !error.message.includes(invalid));
    }
});

test("rotates healthy proxies and pins the context throughout an operation", async t => {
    const { pool } = fixture(t);
    const ids = [];
    for (let i = 0; i < 6; i++) {
        await pool.run("instagram", "www.instagram.com", async attempt => {
            ids.push(attempt.id);
            await Promise.resolve();
            assert.equal(currentProxy(), attempt);
            return success;
        });
    }
    assert.equal(new Set(ids.slice(0, 3)).size, 3);
    for (let i = 1; i < ids.length; i++) assert.notEqual(ids[i], ids[i - 1]);
    assert.equal(currentProxy(), undefined);
});

test("makes at most two attempts, using distinct proxies and cleaning failed attempts", async t => {
    const { pool } = fixture(t);
    const ids = [], cleaned = [];
    const result = await pool.run("instagram", "www.instagram.com", attempt => {
        ids.push(attempt.id);
        attempt.cleanups.push(() => cleaned.push(attempt.id));
        return failure();
    });
    assert.equal(result.body.error.code, "error.api.fetch.fail");
    assert.equal(ids.length, 2);
    assert.equal(new Set(ids).size, 2);
    assert.deepEqual(cleaned, ids);
    assert.equal(pool.entries.reduce((sum, entry) => sum + entry.global.active, 0), 0);
    await pool.run("instagram", "www.instagram.com", attempt => {
        assert.ok(!ids.includes(attempt.id));
        return success;
    });
});

test("a service failure does not blacklist the proxy for another service", async t => {
    const { pool } = fixture(t);
    await pool.run("instagram", "www.instagram.com", () => failure());
    let selected;
    await pool.run("youtube", "www.youtube.com", attempt => {
        selected = attempt.id;
        return success;
    });
    assert.ok(selected);
});

test("content and authentication errors are not retried or penalized", async t => {
    const { pool } = fixture(t);
    for (const code of ["content.post.private", "content.video.unavailable", "link.unsupported", "fetch.empty"]) {
        let calls = 0;
        await pool.run("instagram", "www.instagram.com", () => {
            calls++;
            return failure(code);
        });
        assert.equal(calls, 1);
    }
    assert.ok(pool.entries.every(entry => !entry.services.get("instagram").blockedUntil));
});

test("allows only one recovery probe after the cooldown", async t => {
    const { pool, advance } = fixture(t);
    await pool.run("instagram", "www.instagram.com", () => failure());
    await pool.run("instagram", "www.instagram.com", () => failure());
    advance(30001);
    let resume;
    const pending = pool.run("instagram", "www.instagram.com", () =>
        new Promise(resolve => { resume = resolve; }));
    const probing = pool.entries.find(entry => entry.services.get("instagram").probing);
    assert.ok(probing);
    const other = pool.acquire("instagram", "www.instagram.com", new Set());
    assert.notEqual(other.id, probing.id);
    other.global.active--;
    other.global.probing = false;
    other.services.get("instagram").active--;
    other.services.get("instagram").probing = false;
    resume(success);
    await pending;
    assert.equal(probing.services.get("instagram").blockedUntil, 0);
});

test("increases the cooldown when a recovery probe fails", async t => {
    const { pool, advance } = fixture(t);
    await pool.run("instagram", "www.instagram.com", () => failure());
    await pool.run("instagram", "www.instagram.com", () => failure());
    advance(30001);
    await pool.run("instagram", "www.instagram.com", () => failure());
    await pool.run("instagram", "www.instagram.com", () => failure());
    assert.ok(pool.entries.every(entry =>
        entry.services.get("instagram").blockedUntil === 190001));
});

test("shared deadline also bounds an operation that never resolves", async t => {
    let reads = 0, calls = 0;
    const { pool } = fixture(t, { now: () => reads++ === 0 ? 0 : 30001 });
    await assert.rejects(pool.run("instagram", "www.instagram.com", () => {
        calls++;
        return new Promise(() => {});
    }), /deadline exceeded/);
    assert.equal(calls, 1);
    assert.equal(pool.entries[0].global.active, 0);
});

test("transport errors quarantine a proxy globally, but only until its cooldown expires", async t => {
    const { pool, agents, advance } = fixture(t);
    const error = Object.assign(new Error("connection refused"), { code: "ECONNREFUSED" });
    agents[0].get("https://www.instagram.com").intercept({ path: "/" }).replyWithError(error);
    let calls = 0;
    await pool.run("instagram", "www.instagram.com", async attempt => {
        if (++calls === 1) {
            await fetch("https://www.instagram.com/", { dispatcher: attempt.dispatcher });
        }
        return success;
    });
    assert.equal(calls, 2);
    assert.ok(pool.entries[0].global.blockedUntil > 100000);
    advance(30001);
    assert.equal(pool.available(pool.entries[0].global), true);
});

test("proxy authentication failure remains disabled until restart", async t => {
    const { pool, agents, advance } = fixture(t);
    agents[0].get("https://www.instagram.com").intercept({ path: "/" })
        .replyWithError(new Error("Proxy response (407) !== 200 when HTTP Tunneling"));
    let calls = 0;
    await pool.run("instagram", "www.instagram.com", async attempt => {
        if (++calls === 1) {
            await fetch("https://www.instagram.com/", { dispatcher: attempt.dispatcher });
        }
        return success;
    });
    advance(86400000);
    assert.equal(pool.entries[0].global.blockedUntil, Infinity);
    assert.equal(pool.available(pool.entries[0].global), false);
});

test("concurrent operations have isolated contexts and distribute initial load", async t => {
    const { pool } = fixture(t);
    const ids = [];
    await Promise.all(Array.from({ length: 3 }, () =>
        pool.run("instagram", "www.instagram.com", async attempt => {
            ids.push(attempt.id);
            await new Promise(resolve => setImmediate(resolve));
            assert.equal(currentProxy().id, attempt.id);
            return success;
        })));
    assert.equal(new Set(ids).size, 3);
});

test("observes swallowed HTTP 429 responses and respects Retry-After", async t => {
    const { pool, agents } = fixture(t);
    agents[0].get("https://www.instagram.com").intercept({ path: "/" })
        .reply(429, "limited", { headers: { "retry-after": "120" } });
    let calls = 0;
    await pool.run("instagram", "www.instagram.com", async attempt => {
        calls++;
        if (calls === 1) {
            const response = await fetch("https://www.instagram.com/", { dispatcher: attempt.dispatcher });
            await response.text();
            return failure("fetch.empty");
        }
        return success;
    });
    assert.equal(calls, 2);
    assert.ok(pool.entries[0].services.get("instagram").blockedUntil >= 220000);
    assert.ok(pool.entries[0].domains.get("instagram:www.instagram.com").blockedUntil >= 220000);
});

test("upstream 5xx triggers retry without quarantining the proxy", async t => {
    const { pool, agents } = fixture(t);
    agents[0].get("https://www.instagram.com").intercept({ path: "/" }).reply(503, "unavailable");
    let calls = 0;
    await pool.run("instagram", "www.instagram.com", async attempt => {
        if (++calls === 1) {
            await (await fetch("https://www.instagram.com/", { dispatcher: attempt.dispatcher })).text();
            return failure();
        }
        return success;
    });
    assert.equal(calls, 2);
    assert.equal(pool.entries[0].services.get("instagram").blockedUntil, 0);
});

test("reconstructs a pinned stream dispatcher without an active request context", async t => {
    const { pool, agents } = fixture(t);
    let id;
    await pool.run("instagram", "www.instagram.com", attempt => {
        id = attempt.id;
        return success;
    });
    agents[0].get("https://cdn.example").intercept({ path: "/video" }).reply(200, "media");
    const response = await fetch("https://cdn.example/video", {
        dispatcher: pool.dispatcher(id, "instagram"),
    });
    assert.equal(await response.text(), "media");
    assert.throws(() => pool.dispatcher("missing", "instagram"), /no longer configured/);
});

test("refreshing expired links retains the proxy for implicit outbound requests", async t => {
    const { pool, agents } = fixture(t);
    const id = pool.entries[0].id;
    agents[0].get("https://www.instagram.com")
        .intercept({ path: "/refresh" }).reply(200, "new-link");
    const fallback = new MockAgent(), direct = new MockAgent();
    fallback.disableNetConnect();
    direct.disableNetConnect();
    const router = new ProxyRouter(fallback, direct);
    t.after(() => Promise.all([fallback.close(), direct.close()]));
    await pool.runPinned(id, "instagram", async () => {
        assert.equal(currentProxy().id, id);
        const response = await fetch("https://www.instagram.com/refresh", { dispatcher: router });
        assert.equal(await response.text(), "new-link");
    });
});

test("a failing CDN stream updates the service reputation without changing its proxy", async t => {
    const { pool, agents } = fixture(t);
    agents[0].get("https://cdn.example").intercept({ path: "/video" }).reply(429, "limited");
    const response = await fetch("https://cdn.example/video", {
        dispatcher: pool.dispatcher(pool.entries[0].id, "instagram"),
    });
    await response.text();
    assert.ok(pool.entries[0].media.get("instagram").blockedUntil > 100000);
});

test("concurrent metadata success cannot clear a CDN quarantine", async t => {
    const { pool, agents } = fixture(t);
    let resume, id;
    const pending = pool.run("youtube", "www.youtube.com", attempt => {
        id = attempt.id;
        return new Promise(resolve => { resume = resolve; });
    });
    agents[0].get("https://cdn.example").intercept({ path: "/video" }).reply(403, "");
    const response = await fetch("https://cdn.example/video", {
        dispatcher: pool.dispatcher(id, "youtube", new Set()),
    });
    await response.text();
    resume(success);
    await pending;
    const entry = pool.entries[0];
    assert.equal(entry.media.get("youtube").failures, 1);
    assert.equal(entry.media.get("youtube").blockedUntil, 130000);
    await pool.run("youtube", "www.youtube.com", attempt => {
        assert.notEqual(attempt.id, id);
        return success;
    });
    await pool.run("instagram", "www.instagram.com", () => success);
    assert.equal(entry.media.get("youtube").blockedUntil, 130000);
});

test("one tunnel has one penalty across streams and retries, with Retry-After retained", async t => {
    const { pool, agents } = fixture(t);
    const episode = new Set(), entry = pool.entries[0];
    const origin = agents[0].get("https://cdn.example");
    for (let i = 0; i < 4; i++) {
        origin.intercept({ path: `/${i}` }).reply(i === 3 ? 429 : 403, "", {
            headers: i === 3 ? { "retry-after": "120" } : {},
        });
        await (await fetch(`https://cdn.example/${i}`, {
            dispatcher: pool.dispatcher(entry.id, "youtube", episode),
        })).text();
    }
    assert.equal(entry.media.get("youtube").failures, 1);
    assert.equal(entry.media.get("youtube").blockedUntil, 220000);
    assert.equal(entry.domains.get("youtube:cdn.example").failures, 1);
    origin.intercept({ path: "/new-tunnel" }).reply(403, "");
    await (await fetch("https://cdn.example/new-tunnel", {
        dispatcher: pool.dispatcher(entry.id, "youtube", new Set()),
    })).text();
    assert.equal(entry.media.get("youtube").failures, 2);
    assert.equal(entry.media.get("youtube").blockedUntil, 220000);
});

test("media recovery is exclusive and requires completed data rather than metadata or HEAD", async t => {
    const { pool, agents, advance } = fixture(t);
    const entry = pool.entries[0];
    pool.recordMediaFailure(entry, "youtube", { kind: "blocked" }, new Set());
    advance(30001);
    // Isolate the recovering proxy to exercise the probe rather than healthy alternatives.
    for (const other of pool.entries.slice(1)) other.global.blockedUntil = Infinity;
    await pool.run("youtube", "www.youtube.com", () => success);
    assert.equal(entry.media.get("youtube").probing, true);
    await assert.rejects(pool.run("youtube", "www.youtube.com", () => success), /No available proxy/);
    const origin = agents[0].get("https://cdn.example");
    origin.intercept({ path: "/video", method: "HEAD" }).reply(200, "", {
        headers: { "content-length": "5" },
    });
    const dispatcher = pool.dispatcher(entry.id, "youtube");
    await (await fetch("https://cdn.example/video", { method: "HEAD", dispatcher })).text();
    assert.equal(entry.media.get("youtube").probing, true);
    assert.equal(entry.media.get("youtube").failures, 1);
    origin.intercept({ path: "/empty" }).reply(200, "");
    await (await fetch("https://cdn.example/empty", { dispatcher })).text();
    assert.equal(entry.media.get("youtube").probing, true);
    origin.intercept({ path: "/video" }).reply(206, "video");
    assert.equal(await (await fetch("https://cdn.example/video", { dispatcher })).text(), "video");
    assert.equal(entry.media.get("youtube").probing, false);
    assert.equal(entry.media.get("youtube").blockedUntil, 0);
    assert.equal(entry.media.get("youtube").failures, 0);
});

test("a successful old media request cannot erase a newer ban", async t => {
    const { pool, advance } = fixture(t);
    const entry = pool.entries[0], health = pool.mediaState(entry, "youtube");
    const revision = health.revision;
    pool.recordMediaFailure(entry, "youtube", { kind: "blocked" });
    advance(30001);
    pool.mediaSuccess(entry, "youtube", revision, entry.global.revision);
    assert.equal(health.failures, 1);
    assert.equal(health.blockedUntil, 130000);
});

test("an old metadata success cannot erase a newer metadata failure", async t => {
    const { pool, advance } = fixture(t);
    for (const entry of pool.entries.slice(1)) entry.global.blockedUntil = Infinity;
    let resume;
    const pending = pool.run("youtube", "www.youtube.com", () =>
        new Promise(resolve => { resume = resolve; }));
    await pool.run("youtube", "www.youtube.com", () => failure());
    advance(30001);
    resume(success);
    await pending;
    assert.equal(pool.entries[0].services.get("youtube").failures, 1);
    assert.equal(pool.entries[0].services.get("youtube").blockedUntil, 130000);
});

test("metadata refresh with a stream dispatcher cannot count as media recovery", async t => {
    const { pool, agents, advance } = fixture(t);
    const entry = pool.entries[0];
    pool.recordMediaFailure(entry, "youtube", { kind: "blocked" });
    advance(30001);
    agents[0].get("https://www.youtube.com")
        .intercept({ path: "/player" }).reply(200, "metadata");
    await pool.runPinned(entry.id, "youtube", async () => {
        await (await fetch("https://www.youtube.com/player", {
            dispatcher: pool.dispatcher(entry.id, "youtube"),
        })).text();
    });
    assert.equal(entry.media.get("youtube").failures, 1);
    assert.equal(entry.media.get("youtube").blockedUntil, 130000);
});

test("a media probe that never downloads cannot lock the proxy indefinitely", async t => {
    t.mock.timers.enable({ apis: ["setTimeout"] });
    const { pool, advance } = fixture(t);
    const entry = pool.entries[0];
    pool.recordMediaFailure(entry, "youtube", { kind: "blocked" });
    advance(30001);
    for (const other of pool.entries.slice(1)) other.global.blockedUntil = Infinity;
    await pool.run("youtube", "www.youtube.com", () => success);
    advance(30000);
    t.mock.timers.tick(30000);
    assert.equal(entry.media.get("youtube").probing, false);
    assert.equal(entry.media.get("youtube").failures, 2);
    assert.equal(entry.media.get("youtube").blockedUntil, 220001);
});

test("does not retry application exceptions or expose proxy credentials in logs", async t => {
    const messages = [];
    const { pool } = fixture(t, { log: message => messages.push(message) });
    let calls = 0;
    await assert.rejects(pool.run("instagram", "www.instagram.com", () => {
        calls++;
        throw new TypeError("parser bug");
    }), /parser bug/);
    assert.equal(calls, 1);
    await pool.run("youtube", "www.youtube.com", () => failure());
    assert.ok(messages.every(message => !message.includes("http") && !message.includes("@")));
});

test("logs each attempt with the proxy address but never credentials or media segments", async t => {
    const messages = [];
    const agents = [];
    const pool = new ProxyPool([
        "http://private-user:private-password@proxy-a:3128",
        "http://private-user:private-password@proxy-b:3128",
    ], {
        log: message => messages.push(message),
        agentFactory: () => {
            const agent = new MockAgent();
            agent.disableNetConnect();
            agents.push(agent);
            return agent;
        },
    });
    t.after(() => pool.close());
    let calls = 0, id;
    await pool.run("instagram", "www.instagram.com", attempt => {
        id = attempt.id;
        return ++calls === 1 ? failure() : success;
    });
    assert.deepEqual(messages, [
        `[proxy-pool] service=instagram host=www.instagram.com proxy=proxy-a:3128 proxyId=${pool.entries[0].id} attempt=1/2 result=start`,
        "[proxy-pool] service=instagram proxy=proxy-a:3128 attempt=1/2 result=fetch",
        `[proxy-pool] service=instagram host=www.instagram.com proxy=proxy-b:3128 proxyId=${pool.entries[1].id} attempt=2/2 result=start`,
    ]);
    assert.ok(messages.every(message => !/private-user|private-password|@/.test(message)));
    agents[1].get("https://cdn.example").intercept({ path: "/segment.ts" }).reply(200, "segment");
    const response = await fetch("https://cdn.example/segment.ts", {
        dispatcher: pool.dispatcher(id, "instagram"),
    });
    assert.equal(await response.text(), "segment");
    assert.equal(messages.length, 3);
});

async function localProxy(t, status, body) {
    const calls = [];
    const sockets = new Set();
    const server = createServer();
    server.on("connect", (req, socket) => {
        calls.push({ target: req.url, auth: req.headers["proxy-authorization"] });
        socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        socket.once("data", () => {
            socket.end(`HTTP/1.1 ${status} Response\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        });
    });
    server.on("connection", socket => {
        sockets.add(socket);
        socket.on("close", () => sockets.delete(socket));
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    t.after(() => {
        for (const socket of sockets) socket.destroy();
        return new Promise(resolve => server.close(resolve));
    });
    return { url: `http://user:password@127.0.0.1:${server.address().port}`, calls };
}

test("real CONNECT proxies: retries on a new authenticated proxy and keeps media pinned", async t => {
    const first = await localProxy(t, 429, "limited");
    const second = await localProxy(t, 200, "media");
    const pool = new ProxyPool([first.url, second.url], { log: () => {} });
    const fallback = new MockAgent();
    fallback.disableNetConnect();
    const direct = new Agent();
    const previous = getGlobalDispatcher();
    setGlobalDispatcher(new ProxyRouter(fallback, direct));
    t.after(async () => {
        setGlobalDispatcher(previous);
        await Promise.all([pool.close(), direct.close(), fallback.close()]);
    });
    let id;
    const result = await pool.run("instagram", "instagram.example", async attempt => {
        // No explicit dispatcher: this exercises services using global fetch.
        const response = await fetch("http://instagram.example/metadata");
        const body = await response.text();
        if (response.status !== 200) return failure();
        assert.equal(body, "media");
        id = attempt.id;
        return success;
    });
    assert.equal(result, success);
    const media = await fetch("http://cdn.example/video", { dispatcher: pool.dispatcher(id, "instagram") });
    assert.equal(await media.text(), "media");
    assert.equal(first.calls.length, 1);
    assert.equal(second.calls.length, 2);
    assert.equal(second.calls[1].target, "cdn.example:80");
    assert.equal(second.calls[0].auth, `Basic ${Buffer.from("user:password").toString("base64")}`);
});

test("internal loopback requests never go through a pool proxy", async t => {
    const { pool } = fixture(t);
    const direct = new MockAgent(), fallback = new MockAgent();
    direct.disableNetConnect();
    fallback.disableNetConnect();
    direct.get("http://127.0.0.1:9000").intercept({ path: "/itunnel" }).reply(200, "internal");
    const router = new ProxyRouter(fallback, direct);
    t.after(() => Promise.all([direct.close(), fallback.close()]));
    await pool.run("instagram", "www.instagram.com", async () => {
        const response = await fetch("http://127.0.0.1:9000/itunnel", { dispatcher: router });
        assert.equal(await response.text(), "internal");
        return success;
    });
});
