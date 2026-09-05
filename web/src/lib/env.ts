import * as _env from "$env/static/public";

const getEnv = (_key: string) => {
    const env = _env as Record<string, string | undefined>;
    const key = `WEB_${_key}`;

    if (key in env) {
        return env[key];
    }
}

const getEnvBool = (key: string) => {
    const value = getEnv(key);
    return value && ['1', 'true'].includes(value.toLowerCase());
}

const variables = {
    HOST: getEnv('HOST'),
    PLAUSIBLE_HOST: getEnv('PLAUSIBLE_HOST'),
    PLAUSIBLE_ENABLED: getEnv('HOST') && getEnv('PLAUSIBLE_HOST'),
    DEFAULT_API: getEnv('DEFAULT_API'),
    ENABLE_WEBCODECS: getEnvBool('ENABLE_WEBCODECS'),
    ENABLE_DEPRECATED_YOUTUBE_HLS: getEnvBool('ENABLE_DEPRECATED_YOUTUBE_HLS'),
}

const contacts = {
    discord: "https://discord.gg/pQPt8HBUPu",
    codeberg: "https://git.canine.tools/canine.tools/cobalt",
}

const siriShortcuts = {
    photos: "https://www.icloud.com/shortcuts/14e9aebf04b24156acc34ceccf7e6fcd",
    files: "https://www.icloud.com/shortcuts/2134cd9d4d6b41448b2201f933542b2e",
};

const docs = {
    instanceHosting: "https://docs.hyper.lol/guides/cobalt/overview/",
    webLicense: "https://git.canine.tools/canine.tools/cobalt/src/branch/main/web/LICENSE",
    apiLicense: "https://git.canine.tools/canine.tools/cobalt/src/branch/main/api/LICENSE",
};

const officialApiURL = "https://api.cobalt.tools";

export { donate, officialApiURL, contacts, partners, siriShortcuts, docs };
export default variables;
