import { createRequire } from "node:module";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import path from "node:path";
import { CLI_WORKER_RUNTIME_MODE } from "../../config/runtime.ts";
import { resolveVideoHostRuntime } from "./video-production-host.ts";

const execFile = promisify(execFileCallback);

export interface VideoProbeExpectation {
  minDurationSeconds?: number;
  maxDurationSeconds?: number;
  width?: number;
  height?: number;
  requireAudio?: boolean;
  maxBytes?: number;
  framesPerSecond?: number;
  audioDurationToleranceSeconds?: number;
}

export interface VideoProbeResult {
  sha256: string;
  byteSize: number;
  durationSeconds: number;
  width: number;
  height: number;
  hasAudio: boolean;
  framesPerSecond: number;
}

export function resolveLocalRemotionTools(): { renderer: any; bundler: any; binariesDirectory: string; browserExecutable: string } {
  const cliRequire = createRequire(createRequire(import.meta.url).resolve("@remotion/cli/package.json"));
  const renderer = cliRequire("@remotion/renderer") as any;
  const bundler = cliRequire("@remotion/bundler") as any;
  const platformPackage = process.platform === "win32"
    ? "@remotion/compositor-win32-x64-msvc"
    : process.platform === "linux" && process.arch === "x64"
      ? "@remotion/compositor-linux-x64-gnu"
      : process.platform === "darwin" && process.arch === "arm64"
        ? "@remotion/compositor-darwin-arm64"
        : "@remotion/compositor-darwin-x64";
  const compositorPackage = cliRequire.resolve(`${platformPackage}/package.json`);
  const binariesDirectory = path.dirname(compositorPackage);
  const browserExecutable = process.env.CLAW_REMOTION_BROWSER ?? (CLI_WORKER_RUNTIME_MODE === "host" ? resolveVideoHostRuntime().browser : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : process.platform === "linux" ? "/usr/bin/chromium" : "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
  return { renderer, bundler, binariesDirectory, browserExecutable };
}

export function localMediaBinaryPath(directory: string, name: "ffmpeg" | "ffprobe"): string {
  return path.join(directory, `${name}${process.platform === "win32" ? ".exe" : ""}`);
}

/** Extract three small representative frames for configured vision review. */
export async function sampleVideoFrames(filePath: string, durationSeconds: number): Promise<Array<{ mimeType: "image/jpeg"; data: string }>> {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 600) throw new Error("video_review_duration_invalid");
  const stat = await fs.lstat(filePath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > 256 * 1024 * 1024) throw new Error("video_review_asset_invalid");
  const ffmpegPath = localMediaBinaryPath(resolveLocalRemotionTools().binariesDirectory, "ffmpeg");
  const frames: Array<{ mimeType: "image/jpeg"; data: string }> = [];
  for (const fraction of [0.15, 0.5, 0.85]) {
    const at = Math.max(0, Math.min(durationSeconds - 0.05, durationSeconds * fraction));
    const { stdout } = await execFile(ffmpegPath, ["-v", "error", "-protocol_whitelist", "file,pipe,crypto,data", "-ss", at.toFixed(3), "-i", filePath, "-frames:v", "1", "-vf", "scale=320:-2", "-f", "image2pipe", "-vcodec", "mjpeg", "pipe:1"], {
      windowsHide: true, timeout: 15_000, maxBuffer: 512 * 1024, encoding: "buffer" as BufferEncoding,
    });
    const bytes = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
    if (bytes.length < 128 || bytes.length > 512 * 1024) throw new Error("video_review_frame_invalid");
    frames.push({ mimeType: "image/jpeg", data: bytes.toString("base64") });
  }
  return frames;
}

/** ffprobe metadata plus a full ffmpeg decode; a non-empty file alone is never accepted. */
export async function validateRenderedMp4(filePath: string, expected: VideoProbeExpectation = {}): Promise<VideoProbeResult> {
  const absolutePath = path.resolve(filePath);
  const stat = await fs.lstat(absolutePath);
  const maxBytes = expected.maxBytes ?? 2 * 1024 * 1024 * 1024;
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 64 || stat.size > maxBytes) throw new Error("rendered_mp4_missing_empty_or_oversized");
  const tools = resolveLocalRemotionTools();
  const ffprobePath = localMediaBinaryPath(tools.binariesDirectory, "ffprobe");
  const ffmpegPath = localMediaBinaryPath(tools.binariesDirectory, "ffmpeg");
  const probed = await execFile(ffprobePath, ["-v", "error", "-protocol_whitelist", "file,pipe,crypto,data", "-show_streams", "-show_format", "-of", "json", absolutePath], {
    windowsHide: true, timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
  });
  const metadata = JSON.parse(probed.stdout) as { streams?: Array<{ codec_type?: string; width?: number; height?: number; r_frame_rate?: string; duration?: string }>; format?: { duration?: string } };
  const streams = metadata.streams ?? [];
  const video = streams.find((stream) => stream.codec_type === "video");
  const hasAudio = streams.some((stream) => stream.codec_type === "audio");
  const audio = streams.find((stream) => stream.codec_type === "audio");
  const durationSeconds = Number(metadata.format?.duration);
  const [fpsNumerator, fpsDenominator] = (video?.r_frame_rate ?? "0/1").split("/").map(Number);
  const framesPerSecond = fpsDenominator ? fpsNumerator / fpsDenominator : 0;
  if (!video || !Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new Error("rendered_mp4_stream_metadata_invalid");
  if ((video.width ?? 0) < 1 || (video.width ?? 0) > 3840 || (video.height ?? 0) < 1 || (video.height ?? 0) > 2160 || durationSeconds > 600 || framesPerSecond < 1 || framesPerSecond > 60) {
    throw new Error("rendered_mp4_technical_limits_exceeded");
  }
  if (expected.requireAudio && !hasAudio) throw new Error("rendered_mp4_audio_stream_missing");
  if (audio && expected.audioDurationToleranceSeconds !== undefined) {
    const audioDuration = Number(audio.duration);
    const videoDuration = Number(video.duration);
    if (!Number.isFinite(audioDuration) || !Number.isFinite(videoDuration) || Math.abs(audioDuration - videoDuration) > expected.audioDurationToleranceSeconds) {
      throw new Error("rendered_mp4_audio_timing_mismatch");
    }
  }
  if (expected.width && video.width !== expected.width) throw new Error("rendered_mp4_width_mismatch");
  if (expected.height && video.height !== expected.height) throw new Error("rendered_mp4_height_mismatch");
  if (expected.framesPerSecond && Math.abs(framesPerSecond - expected.framesPerSecond) > 0.01) throw new Error("rendered_mp4_frame_rate_mismatch");
  if (expected.minDurationSeconds !== undefined && durationSeconds < expected.minDurationSeconds) throw new Error("rendered_mp4_duration_too_short");
  if (expected.maxDurationSeconds !== undefined && durationSeconds > expected.maxDurationSeconds) throw new Error("rendered_mp4_duration_too_long");
  // This Remotion build omits the null/framemd5 muxers. Decode every stream and
  // re-encode to a disposable MP4 with bundled codecs; any corrupt packet fails.
  const decodeOutput = `${absolutePath}.${process.pid}.decode-check.mp4`;
  try {
    await execFile(ffmpegPath, ["-v", "error", "-xerror", "-protocol_whitelist", "file,pipe,crypto,data", "-i", absolutePath, "-map", "0:v:0", "-map", "0:a?", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", "-f", "mp4", decodeOutput], {
      windowsHide: true, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
    });
  } finally {
    await fs.rm(decodeOutput, { force: true });
  }
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(absolutePath)) hash.update(chunk as Buffer);
  return {
    sha256: hash.digest("hex"),
    byteSize: stat.size,
    durationSeconds,
    width: video.width ?? 0,
    height: video.height ?? 0,
    hasAudio,
    framesPerSecond,
  };
}

export interface TrustedShotRenderInput {
  shotId: string;
  title: string;
  action: string;
  durationFrames: number;
  imagePath?: string;
  imageContentType?: "image/png" | "image/jpeg" | "image/webp";
  /** Immutable, server-authorized MP4 input only. */
  videoPath?: string;
}

/**
 * Bundles only a server-owned Remotion template. Request text is serialized as
 * JSON data and never treated as TS/JS source. Inputs must already be authorized
 * immutable registry assets by the caller.
 */
export async function renderTrustedVideoTimeline(input: {
  workspacePath: string;
  approvedAssetRoot: string;
  shots: TrustedShotRenderInput[];
  fps: number;
  width: number;
  height: number;
  audioPath?: string;
  outputName: string;
}): Promise<{ outputPath: string; sourcePath: string; sourceText: string; probe: VideoProbeResult }> {
  if (!/^[A-Za-z0-9_-]{1,80}\.mp4$/.test(input.outputName)) throw new Error("render_output_name_invalid");
  if (!input.shots.length || input.shots.length > 80) throw new Error("render_shot_count_invalid");
  if (!Number.isInteger(input.fps) || input.fps < 12 || input.fps > 60) throw new Error("render_fps_invalid");
  if (!Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 144 || input.height < 144 || input.width > 3840 || input.height > 2160) throw new Error("render_dimensions_invalid");
  for (const shot of input.shots) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(shot.shotId) || !Number.isInteger(shot.durationFrames) || shot.durationFrames < 1 || shot.durationFrames > input.fps * 600) {
      throw new Error("render_shot_metadata_invalid");
    }
  }
  const root = await fs.realpath(input.workspacePath);
  let approvedRoot: string | undefined;
  const renderRoot = path.join(root, `trusted-render-${randomUUID()}`);
  const publicDir = path.join(renderRoot, "public");
  await fs.mkdir(publicDir, { recursive: true });
  const shots = [] as Array<{ shotId: string; title: string; action: string; durationFrames: number; imageName: string | null; videoName: string | null }>;
  for (let index = 0; index < input.shots.length; index++) {
    const shot = input.shots[index]!;
    let imageName: string | null = null;
    if (shot.imagePath) {
      approvedRoot ??= await fs.realpath(input.approvedAssetRoot);
      const source = await fs.realpath(shot.imagePath);
      const relative = path.relative(approvedRoot, source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("render_asset_outside_approved_root");
      const extension = shot.imageContentType === "image/png" ? ".png" : shot.imageContentType === "image/jpeg" ? ".jpg" : shot.imageContentType === "image/webp" ? ".webp" : "";
      if (!extension) throw new Error("render_image_type_invalid");
      imageName = `shot-${index}${extension}`;
      await fs.copyFile(source, path.join(publicDir, imageName));
    }
    let videoName: string | null = null;
    if (shot.videoPath) {
      approvedRoot ??= await fs.realpath(input.approvedAssetRoot);
      const source = await fs.realpath(shot.videoPath);
      const relative = path.relative(approvedRoot, source);
      if (!relative || relative.startsWith("..") || path.isAbsolute(relative) || path.extname(source).toLowerCase() !== ".mp4") throw new Error("render_video_asset_invalid");
      videoName = `shot-${index}.mp4`;
      await fs.copyFile(source, path.join(publicDir, videoName));
    }
    shots.push({
      shotId: shot.shotId,
      title: shot.title.slice(0, 240),
      action: shot.action.slice(0, 1000),
      durationFrames: shot.durationFrames,
      imageName,
      videoName,
    });
  }
  let audioName: string | null = null;
  if (input.audioPath) {
    audioName = "narration.audio";
    approvedRoot ??= await fs.realpath(input.approvedAssetRoot);
    const source = await fs.realpath(input.audioPath);
    const relative = path.relative(approvedRoot, source);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("render_asset_outside_approved_root");
    const extension = path.extname(source).toLowerCase();
    if (!new Set([".wav", ".mp3", ".m4a", ".aac"]).has(extension)) throw new Error("render_audio_type_invalid");
    audioName = `narration${extension}`;
    await fs.copyFile(source, path.join(publicDir, audioName));
  }
  const dataFile = path.join(renderRoot, "data.json");
  await fs.writeFile(dataFile, JSON.stringify({ shots, fps: input.fps, width: input.width, height: input.height, audioName }), { flag: "wx" });
  const entryPoint = path.join(renderRoot, "entry.tsx");
  const sourceText = `import React from 'react';\nimport {Audio, Composition, Img, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';\nimport data from './data.json';\nconst Shot=({shot}:{shot:any})=>{const f=useCurrentFrame();const opacity=interpolate(f,[0,Math.min(12,shot.durationFrames-1)],[0,1],{extrapolateRight:'clamp'});return <div style={{width:'100%',height:'100%',position:'relative',background:'#101a27',color:'#fff',fontFamily:'Arial',opacity}}>{shot.videoName?<OffthreadVideo src={staticFile(shot.videoName)} muted style={{position:'absolute',width:'100%',height:'100%',objectFit:'cover'}}/>:shot.imageName&&<Img src={staticFile(shot.imageName)} style={{position:'absolute',width:'100%',height:'100%',objectFit:'cover',opacity:.45}}/>}<div style={{position:'absolute',inset:48,display:'flex',flexDirection:'column',justifyContent:'center',textShadow:'0 2px 12px #000'}}><div style={{fontSize:24,color:'#8bd4c4'}}>{shot.shotId}</div><div style={{fontSize:64,fontWeight:700}}>{shot.title}</div><div style={{fontSize:34,marginTop:24}}>{shot.action}</div></div></div>};\nconst Clip=()=>{let cursor=0;const items=data.shots.map((shot:any)=>{const from=cursor;cursor+=shot.durationFrames;return <Sequence key={shot.shotId} from={from} durationInFrames={shot.durationFrames}><Shot shot={shot}/></Sequence>});return <>{items}{data.audioName&&<Audio src={staticFile(data.audioName)}/>}</>};\nconst Root=()=> <Composition id="ProductionTimeline" component={Clip} durationInFrames={data.shots.reduce((n:number,s:any)=>n+s.durationFrames,0)} fps={data.fps} width={data.width} height={data.height}/>;\nregisterRoot(Root);\n`;
  await fs.writeFile(entryPoint, sourceText, "utf8");
  const { bundler, renderer, browserExecutable, binariesDirectory } = resolveLocalRemotionTools();
  const serveUrl = await bundler.bundle({ entryPoint, publicDir, onProgress: () => undefined });
  const outputPath = path.join(root, input.outputName);
  try {
    const composition = await renderer.selectComposition({ serveUrl, id: "ProductionTimeline", browserExecutable });
    await renderer.renderMedia({ composition, serveUrl, codec: "h264", outputLocation: outputPath, browserExecutable, binariesDirectory, licenseKey: null, concurrency: 2, audioCodec: "aac" });
  } finally {
    await fs.rm(serveUrl, { recursive: true, force: true });
  }
  return { outputPath, sourcePath: entryPoint, sourceText, probe: await validateRenderedMp4(outputPath, { width: input.width, height: input.height, framesPerSecond: input.fps, requireAudio: Boolean(input.audioPath), minDurationSeconds: 0.1 }) };
}
