export class YouTubeCache {
    constructor() {
        this.entries = new Map();
        this.initializing = Promise.resolve();
    }

    async get(key, create, refresh = () => false) {
        let entry = this.entries.get(key);
        if (entry?.pending) return entry.pending;
        if (entry?.value && !entry.invalidated && !refresh(entry.value)) return entry.value;
        if (!entry && this.entries.size >= 64) {
            const disposable = [...this.entries].find(([, value]) => !value.pending);
            if (disposable) this.entries.delete(disposable[0]);
        }
        entry ??= {};
        this.entries.set(key, entry);
        entry.invalidated = false;
        // BotGuard installs its interpreter on globalThis; initialization must not overlap.
        const pending = this.initializing.then(create);
        this.initializing = pending.then(() => {}, () => {});
        entry.pending = pending;
        try {
            const value = await pending;
            entry.value = value;
            return value;
        } catch (error) {
            this.entries.delete(key);
            throw error;
        } finally {
            delete entry.pending;
        }
    }

    invalidate(identity) {
        for (const [key, entry] of this.entries) {
            if (JSON.parse(key)[0] === identity) entry.invalidated = true;
        }
    }
}

export const youtubeCache = new YouTubeCache();
