import { strict as assert } from "node:assert";
import { test } from "node:test";
import { EnvHttpProxyAgent, getGlobalDispatcher, MockAgent, setGlobalDispatcher } from "undici";

test("without PROXY_POOL, standard proxy configuration and redirect responses are unchanged", async t => {
    process.env.PROXY_POOL = "";
    process.env.API_URL = "http://api.example/";
    const { configureProxy } = await import("./proxy.js");
    configureProxy();
    assert.ok(getGlobalDispatcher() instanceof EnvHttpProxyAgent);
    const previous = getGlobalDispatcher();
    const mock = new MockAgent();
    mock.disableNetConnect();
    setGlobalDispatcher(mock);
    t.after(async () => {
        setGlobalDispatcher(previous);
        await mock.close();
        await previous.close();
    });
    mock.get("https://api.streamable.com")
        .intercept({ path: "/videos/abc123" }).reply(200, {
            title: "Test", files: {
                mp4: { url: "https://cdn.example/video.mp4", width: 1280, height: 720 },
            },
        });
    const { default: match } = await import("../processing/match.js");
    const { normalizeRequest } = await import("../processing/request.js");
    const { extract } = await import("../processing/url.js");
    const normalized = await normalizeRequest({ url: "https://streamable.com/abc123" });
    const result = await match({
        ...extract(normalized.data.url), params: normalized.data, authType: "none",
    });
    assert.equal(result.body.status, "redirect");
    assert.equal(result.body.url, "https://cdn.example/video.mp4");
    mock.assertNoPendingInterceptors();
});
