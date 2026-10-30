import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { Dispatcher, ProxyAgent } from "undici";

const context = new AsyncLocalStorage();
const NETWORK_ERRORS = new Set([
    "ECONNREFUSED", "ECONNRESET", "ENETUNREACH", "EHOSTUNREACH",
    "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_HEADERS_TIMEOUT", "UND_ERR_BODY_TIMEOUT", "UND_ERR_SOCKET",
    "UND_ERR_PRX_TLS",
]);
const RETRYABLE_ERRORS = new Set([
    "error.api.fetch.fail", "error.api.fetch.rate", "error.api.fetch.critical",
    "error.api.youtube.login",
]);
const CONDITIONAL_ERRORS = new Set([
    "error.api.fetch.empty", "error.api.fetch.short_link",
]);

export function parseProxyPool(value = "") {
    if (!value.trim()) return [];

    return [...new Set(value.trim().split(/[,\s]+/).map((entry, index) => {
        let url;
        try {
            url = new URL(entry);
            decodeURIComponent(url.username);
            decodeURIComponent(url.password);
        } catch {
            throw new Error(`PROXY_POOL: invalid proxy URL at position ${index + 1}`);
        }
        if (!["http:", "https:"].includes(url.protocol) || !url.hostname
            || url.pathname !== "/" || url.search || url.hash) {
            throw new Error(`PROXY_POOL: expected an HTTP(S) proxy URL at position ${index + 1}`);
        }
        return url.href;
    }))];
}

export const currentProxy = () => context.getStore();

export function isLocalOrigin(origin) {
    const hostname = new URL(origin).hostname;
    return hostname === "localhost" || hostname === "[::1]"
        || /^127\./.test(hostname);
}

function networkFailure(error) {
    for (let cause = error; cause; cause = cause.cause) {
        if (NETWORK_ERRORS.has(cause.code)) return { kind: "network", global: true };
        // undici reports a failed CONNECT as RequestAbortedError.
        if (/Proxy response \(407\)/.test(cause.message)) {
            return { kind: "auth", global: true };
        }
        if (/Proxy response \([45]\d\d\)/.test(cause.message)) {
            return { kind: "connect", global: true };
        }
    }
}

function responseFailure(status, headers, now) {
    if (status === 407) return { kind: "auth", global: true };
    if (status === 403) return { kind: "blocked" };
    if (status === 429) {
        let retryAfter;
        for (let i = 0; i < headers.length; i += 2) {
            if (String(headers[i]).toLowerCase() === "retry-after") {
                const value = String(headers[i + 1]);
                retryAfter = /^\d+$/.test(value)
                    ? Number(value) * 1000 : Date.parse(value) - now;
            }
        }
        return { kind: "rate", retryAfter: Math.max(0, retryAfter || 0) };
    }
    if (status >= 500) return { kind: "upstream" };
}

function state() {
    return {
        failures: 0, blockedUntil: 0, probing: false,
        quality: 0.75, latency: 0, lastUsed: 0, active: 0,
    };
}

class PinnedDispatcher extends Dispatcher {
    constructor(pool, entry, service, attempt) {
        super();
        this.pool = pool;
        this.entry = entry;
        this.service = service;
        this.attempt = attempt;
    }

    dispatch(options, handler) {
        const { pool, entry, service, attempt } = this;
        const hostname = new URL(options.origin).hostname;
        const activeAttempt = !!attempt && !attempt.finished && context.getStore() === attempt;
        const signal = activeAttempt ? attempt.controller.signal : undefined;
        const started = pool.now();
        let observedFailure, removeAbort = () => {};
        const observe = (failure) => {
            observedFailure = failure;
            if (activeAttempt) {
                if (!attempt.failure || failure.global || failure.kind === "rate") {
                    attempt.failure = failure;
                }
            }
            pool.recordDomain(entry, service, hostname, failure);
            if (!activeAttempt && failure.kind !== "upstream" && !failure.global) {
                pool.block(pool.serviceState(entry, service), failure);
            }
        };
        if (signal?.aborted) {
            queueMicrotask(() => handler.onError(signal.reason));
            return false;
        }
        entry.inFlight++;
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            entry.inFlight--;
            removeAbort();
        };
        const wrapped = {
            onConnect(abort, ...args) {
                if (signal) {
                    const cancel = () => abort(signal.reason);
                    signal.addEventListener("abort", cancel, { once: true });
                    removeAbort = () => signal.removeEventListener("abort", cancel);
                    if (signal.aborted) cancel();
                }
                return handler.onConnect(abort, ...args);
            },
            onHeaders(status, headers, ...args) {
                if (activeAttempt) pool.recordLatency(entry, service, pool.now() - started);
                const failure = responseFailure(status, headers, pool.now());
                if (failure) observe(failure);
                return handler.onHeaders(status, headers, ...args);
            },
            onData(chunk) { return handler.onData(chunk); },
            onComplete(trailers) {
                finish();
                if (!observedFailure) pool.recordDomain(entry, service, hostname);
                return handler.onComplete(trailers);
            },
            onError(error) {
                finish();
                const failure = networkFailure(error);
                if (failure && !signal?.aborted) observe(failure);
                return handler.onError(error);
            },
        };
        if (handler.onUpgrade) {
            wrapped.onUpgrade = (...args) => {
                finish();
                return handler.onUpgrade(...args);
            };
        }
        try {
            return entry.agent.dispatch({
                ...options,
                ...(activeAttempt ? { headersTimeout: 10000, bodyTimeout: 10000 } : {}),
            }, wrapped);
        } catch (error) {
            finish();
            throw error;
        }
    }
}

export class ProxyPool {
    constructor(urls, {
        now = Date.now, random = Math.random,
        agentFactory = uri => new ProxyAgent({
            uri, proxyTls: { timeout: 10000 }, requestTls: { timeout: 10000 },
        }),
        log = message => console.warn(message),
    } = {}) {
        this.now = now;
        this.random = random;
        this.log = log;
        this.sequence = 0;
        this.lastPicked = new Map();
        this.entries = urls.map(url => ({
            id: createHash("sha256").update(url).digest("hex").slice(0, 24),
            agent: agentFactory(url),
            global: state(),
            services: new Map(),
            domains: new Map(),
            inFlight: 0,
        }));
    }

    serviceState(entry, service) {
        if (!entry.services.has(service)) entry.services.set(service, state());
        return entry.services.get(service);
    }

    available(health) {
        return !health.probing && this.now() >= health.blockedUntil;
    }

    acquire(service, hostname, excluded) {
        let candidates = this.entries.filter(entry => {
            const health = this.serviceState(entry, service);
            const domain = entry.domains.get(`${service}:${hostname}`);
            return !excluded.has(entry.id) && this.available(entry.global)
                && this.available(health) && (!domain || this.available(domain));
        });
        if (!candidates.length) return;

        if (candidates.length > 1) {
            candidates = candidates.filter(entry => entry.id !== this.lastPicked.get(service));
        }
        // Explore regularly, otherwise prefer reliable, idle proxies.
        const explore = ++this.sequence % 5 === 0;
        candidates.sort((a, b) => {
            const ah = this.serviceState(a, service), bh = this.serviceState(b, service);
            if (explore || !ah.lastUsed || !bh.lastUsed) return ah.lastUsed - bh.lastUsed;
            const score = (entry, health) =>
                (0.25 + health.quality) / (1 + entry.global.active + entry.inFlight)
                / (1 + health.latency / 5000);
            return score(b, bh) - score(a, ah) || ah.lastUsed - bh.lastUsed;
        });
        const entry = candidates[0], health = this.serviceState(entry, service);
        entry.global.active++;
        health.active++;
        if (entry.global.blockedUntil) entry.global.probing = true;
        if (health.blockedUntil) health.probing = true;
        health.lastUsed = ++this.sequence;
        this.lastPicked.set(service, entry.id);
        return entry;
    }

    block(health, failure) {
        health.failures++;
        const delay = failure.kind === "auth" ? Infinity
            : Math.max(
                Math.min(600000, 30000 * 2 ** Math.min(health.failures - 1, 5))
                    * (0.9 + this.random() * 0.2),
                failure.retryAfter || 0,
            );
        health.blockedUntil = this.now() + delay;
        health.quality *= 0.7;
    }

    recordDomain(entry, service, hostname, failure) {
        const key = `${service}:${hostname}`;
        if (!entry.domains.has(key)) {
            // CDN hostnames may be ephemeral; keep memory bounded.
            if (entry.domains.size >= 256) entry.domains.delete(entry.domains.keys().next().value);
            entry.domains.set(key, state());
        }
        const health = entry.domains.get(key);
        if (failure && failure.kind !== "upstream") {
            this.block(health, failure);
        } else if (!failure) {
            health.failures = 0;
            health.blockedUntil = 0;
        }
        if (failure?.global) this.block(entry.global, failure);
    }

    recordLatency(entry, service, milliseconds) {
        const health = this.serviceState(entry, service);
        health.latency = health.latency ? 0.8 * health.latency + 0.2 * milliseconds : milliseconds;
    }

    dispatcher(id, service) {
        const entry = this.entries.find(entry => entry.id === id);
        if (!entry) throw new Error("Pinned proxy is no longer configured");
        return new PinnedDispatcher(this, entry, service);
    }

    async runPinned(id, service, operation) {
        const pinned = {
            id, service, dispatcher: this.dispatcher(id, service),
            controller: new AbortController(), cleanups: [],
        };
        try {
            return await context.run(pinned, operation);
        } catch (error) {
            pinned.controller.abort(error);
            for (const cleanup of pinned.cleanups) cleanup();
            throw error;
        }
    }

    async run(service, hostname, operation) {
        const excluded = new Set();
        const deadline = this.now() + 30000;
        let result, lastError;
        for (let number = 1; number <= 3; number++) {
            const entry = this.acquire(service, hostname, excluded);
            if (!entry) {
                if (lastError) throw lastError;
                if (result) return result;
                throw new Error(`No available proxy for service ${service}`);
            }
            excluded.add(entry.id);
            const attempt = {
                id: entry.id, service, cleanups: [],
                controller: new AbortController(),
            };
            attempt.dispatcher = new PinnedDispatcher(this, entry, service, attempt);
            let timer;
            const timeout = new Promise((_, reject) => {
                timer = setTimeout(() => {
                    attempt.failure = { kind: "timeout" };
                    const error = new Error("Proxy operation deadline exceeded");
                    attempt.controller.abort(error);
                    reject(error);
                }, Math.max(1, deadline - this.now()));
            });
            let thrown;
            try {
                result = await Promise.race([
                    context.run(attempt, () => operation(attempt)), timeout,
                ]);
                lastError = undefined;
            } catch (error) {
                thrown = error;
                lastError = error;
                attempt.failure ??= networkFailure(error);
            } finally {
                clearTimeout(timer);
                attempt.finished = true;
                entry.global.active--;
                entry.global.probing = false;
                const health = this.serviceState(entry, service);
                health.active--;
                health.probing = false;
            }

            const errorCode = result?.body?.error?.code;
            const failed = !!thrown || result?.body?.status === "error";
            const retryable = (thrown && !!attempt.failure)
                || (CONDITIONAL_ERRORS.has(errorCode) ? !!attempt.failure
                    : RETRYABLE_ERRORS.has(errorCode));
            const health = this.serviceState(entry, service);
            if (!failed) {
                health.quality = 0.8 * health.quality + 0.2;
                health.failures = 0;
                health.blockedUntil = 0;
                if (this.now() >= entry.global.blockedUntil) {
                    entry.global.failures = 0;
                    entry.global.blockedUntil = 0;
                }
                return result;
            }

            attempt.controller.abort(new Error("Proxy attempt finished"));
            for (const cleanup of attempt.cleanups) cleanup();
            if (retryable) {
                const failure = attempt.failure || { kind: "fetch" };
                if (failure.kind !== "upstream") this.block(health, failure);
                this.log(`[proxy-pool] service=${service} proxy=${entry.id} attempt=${number}/3 result=${failure.kind}`);
            }
            if (!retryable || number === 3 || this.now() >= deadline) {
                if (thrown) throw thrown;
                return result;
            }
        }
    }

    async close() {
        await Promise.all(this.entries.map(entry => entry.agent.close()));
    }
}

export class ProxyRouter extends Dispatcher {
    constructor(fallback, direct) {
        super();
        this.fallback = fallback;
        this.direct = direct;
    }

    dispatch(options, handler) {
        const dispatcher = isLocalOrigin(options.origin) ? this.direct
            : currentProxy()?.dispatcher || this.fallback;
        return dispatcher.dispatch(options, handler);
    }
}
