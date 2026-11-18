import { workerPaths, compositorPackageName, mediaBinary, scrubWorkerEnv } from "./worker-platform.mjs";
import { boundedLines, runAuthoringSession } from "./authoring-tools.mjs";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { createReadStream } from "node:fs";
import { mkdir, stat, rm, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const workspace = workerPaths.workspace;
const outputRoot = path.join(workspace, "output");
const cliRequire = createRequire(workerPaths.moduleAnchor);
let stage = "request";
let renderTimeout = setTimeout(() => {
  process.stderr.write(`${JSON.stringify({ protocol: "claw-video-worker-v1", stage, event: "timeout" })}\n`);
  process.exit(124);
}, 300_000);

function reportStage(nextStage) {
  stage = nextStage;
  process.stdout.write(`${JSON.stringify({ protocol: "claw-video-worker-v1", stage, event: "started" })}\n`);
}

function fail(code) {
  process.stdout.write(`${JSON.stringify({ protocol: "claw-video-worker-v1", ok: false, error: code })}\n`);
  process.exitCode = 2;
}

const requestLines = boundedLines(process.stdin);
async function readRequest() {
  const first = await requestLines.next();
  if (first.done) throw new Error("request_missing");
  return JSON.parse(first.value);
}

const entryText = `import React from 'react';
import {Composition, Img, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';
import data from './data.json';
const Shot=({shot})=>{const f=useCurrentFrame();const opacity=interpolate(f,[0,Math.min(12,shot.durationFrames-1)],[0,1],{extrapolateRight:'clamp'});return <div style={{width:'100%',height:'100%',position:'relative',background:'#101a27',color:'#fff',fontFamily:'Arial',opacity}}>{shot.imageName&&<Img src={staticFile(shot.imageName)} style={{position:'absolute',width:'100%',height:'100%',objectFit:'cover',opacity:.45}}/>}<div style={{position:'absolute',inset:48,display:'flex',flexDirection:'column',justifyContent:'center',textShadow:'0 2px 12px #000'}}><div style={{fontSize:24,color:'#8bd4c4'}}>{shot.shotId}</div><div style={{fontSize:64,fontWeight:700}}>{shot.title}</div><div style={{fontSize:34,marginTop:24}}>{shot.action}</div></div></div>};
const Clip=()=> <Sequence from={0} durationInFrames={data.shot.durationFrames}><Shot shot={data.shot}/></Sequence>;
const Root=()=> <Composition id="ProductionShot" component={Clip} durationInFrames={data.shot.durationFrames} fps={data.fps} width={data.width} height={data.height}/>;
registerRoot(Root);
`;

async function runFinalTimeline(request, scopedRequire) {
  if (
    request.protocol !== "claw-video-worker-v1" ||
    !/^[0-9a-f-]{36}$/i.test(request.attemptId) ||
    !/^[a-f0-9]{64}$/.test(request.manifestDigest) ||
    !/^[a-f0-9]{64}$/.test(request.inputDigest) ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.timelineArtifactId) ||
    request.fps !== 30 ||
    !((request.width === 720 && request.height === 1280) || (request.width === 1280 && request.height === 720)) ||
    !Array.isArray(request.shots) ||
    request.shots.length < 1 ||
    request.shots.length > 80 ||
    !request.audio
  )
    throw new Error("timeline_request_invalid");
  const jobKey = createHash("sha256").update(`${request.attemptId}:${request.inputDigest}`).digest("hex").slice(0, 24);
  const jobRoot = path.join(workspace, `render-final-${jobKey}`);
  const publicDir = path.join(jobRoot, "public");
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true, mode: 0o700 });
  let totalBytes = 0;
  const shots = [];
  for (let i = 0; i < request.shots.length; i++) {
    const item = request.shots[i];
    const expectedName = `shot-${i}.mp4`;
    if (
      !/^[A-Za-z0-9_-]{1,128}$/.test(item.shotId) ||
      !Number.isInteger(item.shotVersion) ||
      item.shotVersion < 1 ||
      item.inputName !== expectedName ||
      !Number.isInteger(item.durationFrames) ||
      item.durationFrames < 1 ||
      item.durationFrames > 18000 ||
      !Number.isInteger(item.transitionFrames) ||
      item.transitionFrames < 0 ||
      item.transitionFrames > 60 ||
      item.transitionFrames >= item.durationFrames ||
      typeof item.subtitleText !== "string" ||
      item.subtitleText.length > 2000 ||
      !/^[a-f0-9]{64}$/.test(item.sha256)
    )
      throw new Error("timeline_shot_invalid");
    const source = path.join(workspace, "input", expectedName);
    const info = await stat(source);
    if (!info.isFile() || info.size < 64 || info.size > 256 * 1024 * 1024) throw new Error("timeline_clip_invalid");
    totalBytes += info.size;
    if (totalBytes > 1024 * 1024 * 1024) throw new Error("timeline_inputs_too_large");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(source)) digest.update(chunk);
    if (digest.digest("hex") !== item.sha256) throw new Error("timeline_clip_hash_mismatch");
    const videoName = `approved-${i}.mp4`;
    await writeFile(
      path.join(publicDir, videoName),
      await import("node:fs/promises").then(({ readFile }) => readFile(source)),
      { flag: "wx", mode: 0o600 },
    );
    shots.push({
      shotId: item.shotId,
      title: item.shotId,
      durationFrames: item.durationFrames,
      transitionFrames: item.transitionFrames,
      videoName,
    });
  }
  for (let i = 1; i < shots.length; i++)
    if (shots[i].transitionFrames >= shots[i - 1].durationFrames) throw new Error("timeline_transition_invalid");
  let audioName = null;
  if (request.audio) {
    if (
      request.audio.inputName !== "narration.mp3" ||
      !/^[a-f0-9]{64}$/.test(request.audio.sha256) ||
      !Number.isInteger(request.audio.durationFrames) ||
      request.audio.durationFrames < 1 ||
      !Array.isArray(request.audio.cues) ||
      request.audio.cues.length > 500 ||
      request.audio.cues.some(
        (cue) =>
          typeof cue.text !== "string" ||
          cue.text.length > 2000 ||
          !Number.isInteger(cue.startMs) ||
          !Number.isInteger(cue.endMs) ||
          cue.startMs < 0 ||
          cue.endMs <= cue.startMs ||
          cue.endMs > (request.audio.durationFrames * 1000) / request.fps,
      )
    )
      throw new Error("timeline_audio_invalid");
    const source = path.join(workspace, "input", "narration.mp3");
    const info = await stat(source);
    if (!info.isFile() || info.size < 64 || info.size > 64 * 1024 * 1024) throw new Error("timeline_audio_invalid");
    const digest = createHash("sha256");
    for await (const chunk of createReadStream(source)) digest.update(chunk);
    if (digest.digest("hex") !== request.audio.sha256) throw new Error("timeline_audio_hash_mismatch");
    audioName = "narration.mp3";
    await writeFile(
      path.join(publicDir, audioName),
      await import("node:fs/promises").then(({ readFile }) => readFile(source)),
      { flag: "wx", mode: 0o600 },
    );
  }
  await writeFile(
    path.join(jobRoot, "data.json"),
    JSON.stringify({
      shots,
      fps: request.fps,
      width: request.width,
      height: request.height,
      audioName,
      cues: request.audio.cues,
    }),
    { flag: "wx", mode: 0o600 },
  );
  const sourceText = `import React from 'react';\nimport {Audio, Composition, OffthreadVideo, Sequence, interpolate, registerRoot, staticFile, useCurrentFrame} from 'remotion';\nimport data from './data.json';\nconst Shot=({shot}:{shot:any})=>{const f=useCurrentFrame();const fade=shot.transitionFrames?interpolate(f,[0,shot.transitionFrames],[0,1],{extrapolateRight:'clamp'}):1;return <div style={{width:'100%',height:'100%',background:'#000',position:'relative',opacity:fade}}><OffthreadVideo src={staticFile(shot.videoName)} muted style={{width:'100%',height:'100%',objectFit:'cover'}}/></div>};\nconst Clip=()=>{let cursor=0;const items=data.shots.map((shot:any)=>{const from=cursor-(shot.transitionFrames||0);cursor=from+shot.durationFrames;return <Sequence key={shot.shotId} from={from} durationInFrames={shot.durationFrames}><Shot shot={shot}/></Sequence>});const frame=useCurrentFrame();const cue=data.cues.find((item:any)=>frame>=Math.floor(item.startMs*data.fps/1000)&&frame<Math.ceil(item.endMs*data.fps/1000));return <>{items}<Audio src={staticFile(data.audioName)}/>{cue&&<div style={{position:'absolute',left:40,right:40,bottom:20,textAlign:'center',fontSize:28,color:'white',textShadow:'0 2px 8px black'}}>{cue.text}</div>}</>};\nconst Root=()=> <Composition id="ApprovedRoughCut" component={Clip} durationInFrames={data.shots.reduce((n:number,s:any)=>n+s.durationFrames-(s.transitionFrames||0),0)} fps={data.fps} width={data.width} height={data.height}/>;\nregisterRoot(Root);\n`;
  await writeFile(path.join(jobRoot, "entry.tsx"), sourceText, { flag: "wx", mode: 0o600 });
  const { bundle } = scopedRequire("@remotion/bundler");
  const { renderMedia, selectComposition } = scopedRequire("@remotion/renderer");
  const compositorPackage = scopedRequire.resolve(compositorPackageName() + "/package.json");
  const binariesDirectory = path.dirname(compositorPackage);
  const browserExecutable = workerPaths.browser;
  reportStage("bundle");
  const serveUrl = await bundle({
    entryPoint: path.join(jobRoot, "entry.tsx"),
    publicDir,
    onProgress: () => undefined,
    webpackOverride: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.modules = [...(config.resolve.modules ?? ["node_modules"]), workerPaths.dependencies];
      return config;
    },
  });
  const outputPath = path.join(outputRoot, "final.mp4");
  await mkdir(outputRoot, { recursive: true });
  try {
    reportStage("select_composition");
    const composition = await selectComposition({ serveUrl, id: "ApprovedRoughCut", browserExecutable });
    reportStage("render_media");
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      browserExecutable,
      binariesDirectory,
      licenseKey: null,
      concurrency: 2,
      audioCodec: "aac",
    });
  } finally {
    await rm(serveUrl, { recursive: true, force: true });
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(outputPath)) digest.update(chunk);
  const outputStat = await stat(outputPath);
  const result = {
    protocol: "claw-video-worker-v1",
    ok: true,
    operation: "render-timeline",
    attemptId: request.attemptId,
    manifestDigest: request.manifestDigest,
    timelineArtifactId: request.timelineArtifactId,
    inputDigest: request.inputDigest,
    output: "output/final.mp4",
    byteSize: outputStat.size,
    sha256: digest.digest("hex"),
    sourceOutput: `render-final-${jobKey}/entry.tsx`,
  };
  await writeFile(path.join(outputRoot, "result.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
  return result;
}

try {
  reportStage("request");
  const request = await readRequest();
  if (request?.operation === "render-timeline") {
    const cliPackage = cliRequire.resolve("@remotion/cli/package.json");
    const scopedRequire = createRequire(cliPackage);
    const result = await runFinalTimeline(request, scopedRequire);
    clearTimeout(renderTimeout);
    reportStage("complete");
    process.stdout.write(
      `${JSON.stringify({ protocol: "claw-video-worker-v1", ok: true, outputSha256: result.sha256 })}\n`,
    );
    process.exit(0);
  }
  if (
    request?.protocol !== "claw-video-worker-v1" ||
    !["render-shot", "author-shot"].includes(request?.operation) ||
    !/^[0-9a-f-]{36}$/i.test(request.attemptId) ||
    !request.shot ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(request.shot.shotId) ||
    !Number.isInteger(request.shot.shotVersion) ||
    request.shot.shotVersion < 1 ||
    typeof request.shot.action !== "string" ||
    request.shot.action.length > 2000 ||
    typeof request.shot.title !== "string" ||
    request.shot.title.length > 240 ||
    !Number.isInteger(request.shot.durationFrames) ||
    request.shot.durationFrames < 1 ||
    request.shot.durationFrames > 18000 ||
    !((request.width === 720 && request.height === 1280) || (request.width === 1280 && request.height === 720)) ||
    request.fps !== 30
  ) {
    throw new Error("request_schema_invalid");
  }
  if (request.operation === "author-shot") {
    clearTimeout(renderTimeout);
    renderTimeout = setTimeout(() => process.exit(124), 1_200_000);
    await runAuthoringSession(request, requestLines, (value) => process.stdout.write(JSON.stringify(value) + "\n"));
    clearTimeout(renderTimeout);
    process.exit(0);
  }
  const shotHash = createHash("sha256")
    .update(`${request.shot.shotId}:v${request.shot.shotVersion}`)
    .digest("hex")
    .slice(0, 24);
  const jobRoot = path.join(workspace, `render-${shotHash}`);
  const publicDir = path.join(jobRoot, "public");
  await rm(jobRoot, { recursive: true, force: true });
  await mkdir(publicDir, { recursive: true, mode: 0o700 });
  let imageName = null;
  if (request.referenceImage) {
    const image = request.referenceImage;
    if (
      !["image/png", "image/jpeg", "image/webp"].includes(image.contentType) ||
      typeof image.base64 !== "string" ||
      image.base64.length > 12 * 1024 * 1024
    ) {
      throw new Error("reference_image_invalid");
    }
    const extension = image.contentType === "image/png" ? "png" : image.contentType === "image/jpeg" ? "jpg" : "webp";
    imageName = `reference.${extension}`;
    const bytes = Buffer.from(image.base64, "base64");
    if (bytes.toString("base64") !== image.base64) throw new Error("reference_image_encoding_invalid");
    await writeFile(path.join(publicDir, imageName), bytes, { flag: "wx", mode: 0o600 });
  }
  const shot = { ...request.shot, imageName };
  await writeFile(
    path.join(jobRoot, "data.json"),
    JSON.stringify({ shot, fps: 30, width: request.width, height: request.height }),
    { flag: "wx", mode: 0o600 },
  );
  await writeFile(path.join(jobRoot, "entry.tsx"), entryText, { flag: "wx", mode: 0o600 });
  reportStage("bundle");
  const cliPackage = cliRequire.resolve("@remotion/cli/package.json");
  const scopedRequire = createRequire(cliPackage);
  const { bundle } = scopedRequire("@remotion/bundler");
  const { renderMedia, selectComposition } = scopedRequire("@remotion/renderer");
  const compositorPackage = scopedRequire.resolve(compositorPackageName() + "/package.json");
  const binariesDirectory = path.dirname(compositorPackage);
  const browserExecutable = workerPaths.browser;
  const serveUrl = await bundle({
    entryPoint: path.join(jobRoot, "entry.tsx"),
    publicDir,
    onProgress: () => undefined,
    webpackOverride: (config) => {
      config.resolve = config.resolve ?? {};
      config.resolve.modules = [...(config.resolve.modules ?? ["node_modules"]), workerPaths.dependencies];
      return config;
    },
  });
  const outputPath = path.join(outputRoot, `shot-${shotHash}.mp4`);
  await mkdir(outputRoot, { recursive: true });
  try {
    reportStage("select_composition");
    const composition = await selectComposition({ serveUrl, id: "ProductionShot", browserExecutable });
    reportStage("render_media");
    await renderMedia({
      composition,
      serveUrl,
      codec: "h264",
      outputLocation: outputPath,
      browserExecutable,
      binariesDirectory,
      licenseKey: null,
      concurrency: 2,
    });
  } finally {
    await rm(serveUrl, { recursive: true, force: true });
  }
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(outputPath)) digest.update(chunk);
  const outputStat = await stat(outputPath);
  const result = {
    protocol: "claw-video-worker-v1",
    ok: true,
    attemptId: request.attemptId,
    shotId: request.shot.shotId,
    shotVersion: request.shot.shotVersion,
    output: path.relative(workspace, outputPath).replaceAll("\\", "/"),
    byteSize: outputStat.size,
    sha256: digest.digest("hex"),
    sourceOutput: `render-${shotHash}/entry.tsx`,
  };
  await writeFile(path.join(outputRoot, "result.json"), JSON.stringify(result), { flag: "wx", mode: 0o600 });
  clearTimeout(renderTimeout);
  reportStage("complete");
  process.stdout.write(`${JSON.stringify({ protocol: "claw-video-worker-v1", ok: true })}\n`);
} catch (error) {
  clearTimeout(renderTimeout);
  const message =
    stage === "bundle"
      ? "render_bundle_failed"
      : stage === "select_composition"
        ? "render_composition_failed"
        : stage === "render_media"
          ? "render_media_failed"
          : "worker_execution_failed";
  process.stderr.write(`${JSON.stringify({ protocol: "claw-video-worker-v1", stage, event: "failed" })}\n`);
  fail(message);
}
