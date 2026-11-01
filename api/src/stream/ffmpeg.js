import ffmpeg from "ffmpeg-static";
import { spawn } from "child_process";
import { create as contentDisposition } from "content-disposition-header";

import { env } from "../config.js";
import { destroyInternalStream } from "./manage.js";
import { hlsExceptions } from "../processing/service-config.js";
import { closeResponse, pipe, estimateTunnelLength, estimateAudioMultiplier } from "./shared.js";
import { ffmpegError, logTunnel } from "./diagnostics.js";

const metadataTags = new Set([
    "album",
    "composer",
    "genre",
    "copyright",
    "title",
    "artist",
    "album_artist",
    "track",
    "date",
    "sublanguage"
]);

const convertMetadataToFFmpeg = (metadata) => {
    const args = [];

    for (const [ name, value ] of Object.entries(metadata)) {
        if (metadataTags.has(name)) {
            if (name === "sublanguage") {
                args.push('-metadata:s:s:0', `language=${value}`);
                continue;
            }
            args.push('-metadata', `${name}=${value.replace(/[\u0000-\u0009]/g, '')}`); // skipcq: JS-0004
        } else {
            throw `${name} metadata tag is not supported.`;
        }
    }

    return args;
}

const killProcess = (p) => {
    p?.kill('SIGTERM'); // ask the process to terminate itself gracefully

    setTimeout(() => {
        if (p?.exitCode === null)
            p?.kill('SIGKILL'); // brutally murder the process if it didn't quit
    }, 5000);
}

const getCommand = (args) => {
    const ffmpegPath = env.useSystemFFmpeg ? "ffmpeg" : ffmpeg;
    if (typeof env.processingPriority === 'number' && !isNaN(env.processingPriority)) {
        return ['nice', ['-n', env.processingPriority.toString(), ffmpegPath, ...args]]
    }
    return [ffmpegPath, args]
}

const render = async (res, streamInfo, ffargs, estimateMultiplier) => {
    let process;
    const debug = env.tunnelDebug;
    let stderr = "";
    let shutdownRequested = false;
    const urls = Array.isArray(streamInfo.urls) ? streamInfo.urls : [streamInfo.urls];
    const shutdown = () => {
        if (shutdownRequested) return;
        shutdownRequested = true;
        killProcess(process);
        closeResponse(res);
        urls.map(destroyInternalStream);
    };

    try {
        const args = [
            '-loglevel', debug ? 'error' : '-8',
            ...ffargs,
        ];

        process = spawn(...getCommand(args), {
            windowsHide: true,
            stdio: [
                'inherit', 'inherit', debug ? 'pipe' : 'inherit',
                'pipe'
            ],
             env: {
                "http_proxy": "",
                "https_proxy": "",
            }
        });
        process.on("error", error => {
            logTunnel("ffmpeg-spawn-error", streamInfo, { error });
            shutdown();
        });
        process.on("close", (code, signal) => {
            logTunnel("ffmpeg-exit", streamInfo, {
                code, signal, shutdownRequested, ...ffmpegError(stderr),
            });
            shutdown();
        });
        if (debug) {
            process.stderr.on("data", chunk => {
                stderr = (stderr + chunk.toString()).slice(-8192);
            });
        }
        process.once("spawn", () => logTunnel("ffmpeg-start", streamInfo, {
            childPid: process.pid, inputs: urls.length, system: env.useSystemFFmpeg,
        }));

        const [,,, muxOutput] = process.stdio;

        res.setHeader('Connection', 'keep-alive');
        res.setHeader('Content-Disposition', contentDisposition(streamInfo.filename));

        const estimatedSize = await estimateTunnelLength(streamInfo, estimateMultiplier);
        if (shutdownRequested) return;
        logTunnel("estimated-size", streamInfo, { bytes: estimatedSize });
        res.setHeader('Estimated-Content-Length', estimatedSize);

        pipe(muxOutput, res, shutdown, streamInfo);

        res.on('finish', shutdown);
    } catch (error) {
        logTunnel("ffmpeg-error", streamInfo, { error });
        shutdown();
    }
}

const remux = async (streamInfo, res) => {
    const format = streamInfo.filename.split('.').pop();
    const urls = Array.isArray(streamInfo.urls) ? streamInfo.urls : [streamInfo.urls];
    let args = urls.flatMap(url => ['-i', url]);

    if (env.useSystemFFmpeg && streamInfo.isHLS) {
        args = urls.flatMap(url => ['-extension_picky', '0', '-i', url]);
    }

    // if the stream type is merge, we expect two URLs
    if (streamInfo.type === 'merge' && urls.length !== 2) {
        return closeResponse(res);
    }

    if (streamInfo.subtitles) {
        args.push(
            '-i', streamInfo.subtitles,
            '-map', `${urls.length}:s`,
            '-c:s', format === 'mp4' ? 'mov_text' : 'webvtt',
        );
    }

    if (urls.length === 2) {
        args.push(
            '-map', '0:v',
            '-map', '1:a',
        );
    } else {
        args.push(
            '-map', '0:v:0',
            '-map', '0:a:0?'
        );
    }

    args.push(
        '-c:v', 'copy',
        ...(streamInfo.type === 'mute' ? ['-an'] : ['-c:a', 'copy'])
    );

    if (format === 'mp4') {
        args.push('-movflags', 'faststart+frag_keyframe+empty_moov');
    }

    if (streamInfo.type !== 'mute' && streamInfo.isHLS && hlsExceptions.has(streamInfo.service)) {
        if (streamInfo.service === 'youtube' && format === 'webm') {
            args.push('-c:a', 'libopus');
        } else {
            args.push('-c:a', 'aac', '-bsf:a', 'aac_adtstoasc');
        }
    }

    if (streamInfo.metadata) {
        args.push(...convertMetadataToFFmpeg(streamInfo.metadata));
    }

    args.push('-f', format === 'mkv' ? 'matroska' : format, 'pipe:3');

    await render(res, streamInfo, args);
}

const convertAudio = async (streamInfo, res) => {
    const args = [
        '-i', streamInfo.urls,
    ];

    if (streamInfo.cover) {
        args.push(
            '-i', streamInfo.cover,
            ...(streamInfo.cropCover ? [
                '-vf', 'scale=-1:720,crop=720:720'
            ] : []),
        )
    } else {
        args.push('-vn');
    }

    if (streamInfo.audioCopy) {
        args.push('-c:a', 'copy');
    } else {
        args.push('-b:a', `${streamInfo.audioBitrate}k`);
    }

    if (streamInfo.audioFormat === 'mp3' && streamInfo.audioBitrate === '8') {
        args.push('-ar', '12000');
    }

    if (streamInfo.audioFormat === 'opus') {
        args.push('-vbr', 'off');
    }

    if (['mp4a', 'm4a'].includes(streamInfo.audioFormat)) {
        args.push(
            '-movflags', 'frag_keyframe+empty_moov',
            '-frag_duration', '1000000'
        );
    }

    if (streamInfo.metadata) {
        args.push(...convertMetadataToFFmpeg(streamInfo.metadata));
    }

    args.push(
        '-f',
        streamInfo.audioFormat === 'm4a' ? 'ipod' : streamInfo.audioFormat,
        'pipe:3',
    );

    await render(
        res,
        streamInfo,
        args,
        estimateAudioMultiplier(streamInfo) * 1.1,
    );
}

const convertGif = async (streamInfo, res) => {
    const args = [
        '-i', streamInfo.urls,

        '-vf',
        'scale=-1:-1:flags=lanczos,split[s0][s1];[s0]palettegen[p];[s1][p]paletteuse',
        '-loop', '0',

        '-f', 'gif', 'pipe:3',
    ];

    await render(
        res,
        streamInfo,
        args,
        60,
    );
}

export default {
    remux,
    convertAudio,
    convertGif,
}
