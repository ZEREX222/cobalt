import { strict as assert } from "node:assert";
import { test } from "node:test";
import { YouTubeCache } from "./youtube-cache.js";

test("concurrent requests wait for complete initialization of their own proxy session", async () => {
    const cache = new YouTubeCache();
    let finish, calls = 0;
    const create = () => {
        calls++;
        return new Promise(resolve => { finish = resolve; });
    };
    const first = cache.get("proxy-a", create);
    const second = cache.get("proxy-a", create);
    await Promise.resolve();
    assert.equal(calls, 1);
    assert.equal(cache.entries.get("proxy-a").value, undefined);
    const session = { player: "player-a", token: "ready" };
    finish(session);
    assert.equal(await first, session);
    assert.equal(await second, session);
    assert.equal(await cache.get("proxy-a", create), session);
    assert.equal(calls, 1);
});

test("proxy initialization is isolated and serialized for the global BotGuard interpreter", async () => {
    const cache = new YouTubeCache();
    let finish;
    const events = [];
    const first = cache.get("proxy-a", async () => {
        events.push("a-start");
        await new Promise(resolve => { finish = resolve; });
        events.push("a-end");
        return { player: "a" };
    });
    const second = cache.get("proxy-b", async () => {
        events.push("b-start");
        return { player: "b" };
    });
    await Promise.resolve();
    assert.deepEqual(events, ["a-start"]);
    finish();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(events, ["a-start", "a-end", "b-start"]);
    assert.notEqual(a, b);
    assert.equal(a.player, "a");
    assert.equal(b.player, "b");
});

test("failed initialization is propagated to waiters and can be retried", async () => {
    const cache = new YouTubeCache();
    const error = new Error("initialization failed");
    const first = cache.get("proxy-a", async () => { throw error; });
    const second = cache.get("proxy-a", () => assert.fail("duplicate initialization"));
    await Promise.all([
        assert.rejects(first, value => value === error),
        assert.rejects(second, value => value === error),
    ]);
    const session = await cache.get("proxy-a", async () => ({ ready: true }));
    assert.equal(session.ready, true);
});

test("refresh is coalesced without mutating sessions already in use", async () => {
    const cache = new YouTubeCache();
    const old = await cache.get("proxy-a", async () => ({ player: "old" }));
    let calls = 0;
    const refresh = async () => { calls++; return { player: "new" }; };
    const [first, second] = await Promise.all([
        cache.get("proxy-a", refresh, () => true),
        cache.get("proxy-a", refresh, () => true),
    ]);
    assert.equal(calls, 1);
    assert.equal(first, second);
    assert.equal(first.player, "new");
    assert.equal(old.player, "old");
});

test("completed sessions have bounded cache retention", async () => {
    const cache = new YouTubeCache();
    for (let i = 0; i < 100; i++) {
        await cache.get(`proxy-${i}`, async () => ({ ready: true }));
    }
    assert.equal(cache.entries.size, 64);
});

test("invalidating a CDN-failed proxy leaves other proxies cached", async () => {
    const cache = new YouTubeCache();
    const aKey = JSON.stringify(["proxy-a", "TV"]);
    const bKey = JSON.stringify(["proxy-b", "TV"]);
    const a = await cache.get(aKey, async () => ({ player: "a" }));
    const b = await cache.get(bKey, async () => ({ player: "b" }));
    cache.invalidate("proxy-a");
    assert.notEqual(await cache.get(aKey, async () => ({ player: "new-a" })), a);
    assert.equal(await cache.get(bKey, () => assert.fail("proxy-b must remain cached")), b);
});

test("invalidation during initialization is retained for the next request", async () => {
    const cache = new YouTubeCache(), key = JSON.stringify(["proxy-a"]);
    let finish;
    const first = cache.get(key, () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    cache.invalidate("proxy-a");
    finish({ player: "a" });
    await first;
    assert.equal((await cache.get(key, async () => ({ player: "refreshed" }))).player, "refreshed");
});

test("the YouTube service clones context and uses the player and token belonging to its proxy", async t => {
    process.env.API_URL = "http://api.example/";
    const { Innertube, UniversalCache } = await import("youtubei.js");
    const { MockAgent } = await import("undici");
    const { currentProxy, ProxyPool } = await import("../../misc/proxy-pool.js");
    const { env } = await import("../../config.js");
    const { default: youtube } = await import("../services/youtube.js");
    const generate = env.ytGeneratePoTokens;
    env.ytGeneratePoTokens = false;
    t.after(() => { env.ytGeneratePoTokens = generate; });
    const pool = new ProxyPool(["http://session-a:3128", "http://session-b:3128"], {
        log: () => {},
        agentFactory: () => {
            const agent = new MockAgent();
            agent.disableNetConnect();
            return agent;
        },
    });
    t.after(() => pool.close());
    let creations = 0;
    t.mock.method(Innertube, "create", async () => {
        creations++;
        const id = currentProxy().id;
        return { session: {
            context: { client: { visitorData: id }, user: {} },
            api_key: "test-key", api_version: "v1", account_index: 0,
            config_data: {}, player: { player_id: id },
            cache: new UniversalCache(false), po_token: id,
        } };
    });
    const sessions = [];
    t.mock.method(Innertube.prototype, "getPost", async function() {
        const id = currentProxy().id;
        assert.equal(this.session.context.client.visitorData, id);
        assert.equal(this.session.player.player_id, id);
        assert.equal(this.session.po_token, id);
        sessions.push(this.session);
        this.session.context.client.visitorData = "request-local-mutation";
        return { posts: [] };
    });
    const request = id => pool.runPinned(id, "youtube", () => youtube({
        postId: "test-post", innertubeClient: "TV",
        dispatcher: currentProxy().dispatcher,
    }));
    await Promise.all(pool.entries.map(entry => request(entry.id)));
    await request(pool.entries[0].id);
    assert.equal(creations, 2);
    assert.equal(sessions.length, 3);
    assert.equal(new Set(sessions.map(session => session.context)).size, 3);
});
