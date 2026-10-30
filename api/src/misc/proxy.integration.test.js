import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { fetch, MockAgent, ProxyAgent } from "undici";

test("API metadata retries, encrypted tunnels and nested media keep the selected proxy", async t => {
    const urls = ["http://proxy-a:3128/", "http://proxy-b:3128/"];
    process.env.PROXY_POOL = urls.join(",");
    process.env.API_URL = "http://api.example/";
    const ids = urls.map(url => createHash("sha256").update(url).digest("hex").slice(0, 24));
    const { currentProxy } = await import("./proxy-pool.js");
    const agents = ids.map(() => {
        const agent = new MockAgent();
        agent.disableNetConnect();
        return agent;
    });
    const routes = new WeakMap();
    t.mock.method(ProxyAgent.prototype, "dispatch", function(options, handler) {
        if (currentProxy()) routes.set(this, currentProxy().id);
        const index = ids.indexOf(routes.get(this));
        assert.ok(index >= 0);
        return agents[index].dispatch(options, handler);
    });
    t.after(() => Promise.all(agents.map(agent => agent.close())));

    agents[0].get("https://api.streamable.com")
        .intercept({ path: "/videos/abc123" }).reply(429, "{}");
    agents[1].get("https://api.streamable.com")
        .intercept({ path: "/videos/abc123" }).reply(200, {
            title: "Test", files: {
                mp4: { url: "https://cdn.example/video.mp4", width: 1280, height: 720 },
            },
        });
    agents[1].get("https://cdn.example")
        .intercept({ path: "/video.mp4" }).reply(200, "video");
    agents[1].get("https://cdn.example")
        .intercept({ path: "/segment.ts" }).reply(200, "segment");

    const { default: match } = await import("../processing/match.js");
    const { env } = await import("../config.js");
    const { validateEnvs } = await import("../core/env.js");
    assert.equal(env.proxyPool, urls.join(","));
    await assert.rejects(validateEnvs({ ...env, proxyPool: "socks5://proxy:1080" }), /PROXY_POOL/);
    await assert.rejects(validateEnvs({ ...env, freebindCIDR: "2001:db8::/32" }), /FREEBIND_CIDR/);
    const { normalizeRequest } = await import("../processing/request.js");
    const { extract } = await import("../processing/url.js");
    const {
        createInternalStream, getInternalTunnelFromURL, verifyStream,
    } = await import("../stream/manage.js");
    const normalized = await normalizeRequest({ url: "https://streamable.com/abc123" });
    assert.equal(normalized.success, true);
    const parsed = extract(normalized.data.url);
    const response = await match({
        ...parsed, params: normalized.data, authType: "none",
    });
    assert.equal(response.body.status, "tunnel");
    assert.equal(response.status, 200);
    const tunnelURL = new URL(response.body.url);
    const query = tunnelURL.searchParams;
    const stream = await verifyStream(
        query.get("id"), query.get("sig"), query.get("exp"), query.get("sec"), query.get("iv"),
    );
    assert.equal(stream.proxyId, ids[1]);
    const internal = getInternalTunnelFromURL(stream.urls);
    assert.equal(internal.proxyId, ids[1]);
    const video = await fetch(internal.url, { dispatcher: internal.dispatcher });
    assert.equal(await video.text(), "video");
    const nested = getInternalTunnelFromURL(createInternalStream(
        "https://cdn.example/segment.ts", internal,
    ));
    assert.equal(nested.proxyId, ids[1]);
    assert.equal(nested.proxyService, "streamable");
    const segment = await fetch(nested.url, { dispatcher: nested.dispatcher });
    assert.equal(await segment.text(), "segment");
    agents.forEach(agent => agent.assertNoPendingInterceptors());
});
