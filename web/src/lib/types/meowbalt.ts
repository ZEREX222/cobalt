export const emotions = [
    "distress",
    "halt",
    "happy",
    "hi",
    "hiss",
    "hmph",
    "love",
    "pat",
    "sleep",
    "think",
    "tired",
    "trade"
] as const;

export type MeowbaltEmotion = (typeof emotions)[number];
export type MeowbaltEmotions = MeowbaltEmotion | "random";