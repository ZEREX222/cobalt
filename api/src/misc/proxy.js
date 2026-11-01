import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";
import { env } from "../config.js";
import { parseProxyPool, ProxyPool, ProxyRouter } from "./proxy-pool.js";

let pool, configured;

export function configureProxy() {
    const signature = JSON.stringify([env.proxyPool, env.httpProxyValues, env.externalProxy]);
    if (signature === configured) return;
    if (configured && env.proxyPool !== JSON.parse(configured)[0]) {
        throw new Error("Changing PROXY_POOL requires an API restart");
    }
    const urls = parseProxyPool(env.proxyPool);
    pool ??= urls.length ? new ProxyPool(urls) : undefined;
    const fallback = new EnvHttpProxyAgent({ httpProxy: env.externalProxy || undefined });
    setGlobalDispatcher(pool ? new ProxyRouter(fallback, new Agent()) : fallback);
    configured = signature;
}

export function withProxyPool(service, hostname, operation) {
    configureProxy();
    return pool ? pool.run(service, hostname, operation) : operation();
}

export function pinnedProxyDispatcher(id, service, episode) {
    configureProxy();
    if (!pool) throw new Error("Pinned proxy pool is not configured");
    return pool.dispatcher(id, service, episode);
}

export function withPinnedProxy(id, service, operation) {
    if (!id) return operation();
    configureProxy();
    if (!pool) throw new Error("Pinned proxy pool is not configured");
    return pool.runPinned(id, service, operation);
}
