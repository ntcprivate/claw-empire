import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { workerPaths, scrubWorkerEnv } from "./worker-platform.mjs";
import { boundedLines } from "./authoring-tools.mjs";

const image = process.argv[2] ?? "claw-shotcraft-fixture:local";
const workspace = await mkdtemp(path.join(os.tmpdir(), "claw-shotcraft-smoke-"));
const attemptId = randomUUID(),
  name = `claw-shotcraft-smoke-${attemptId.slice(0, 8)}`;
const request = {
  protocol: "claw-video-worker-v1",
  operation: "author-shot",
  attemptId,
  shot: {
    shotId: "fixture",
    shotVersion: 1,
    title: "Vietnamese typography",
    action: "Typography reveal",
    durationFrames: 30,
  },
  width: 1280,
  height: 720,
  fps: 30,
};
const child = spawn(
  workerPaths.host ? process.execPath : "docker",
  workerPaths.host
    ? [new URL("./worker-runner.mjs", import.meta.url).pathname.replace(/^\/(?=[A-Za-z]:)/, "")].map(decodeURIComponent)
    : [
        "run",
        "--name",
        name,
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges",
        "--user",
        "65532:65532",
        "--pids-limit",
        "256",
        "--memory",
        "2g",
        "--cpus",
        "4",
        "--tmpfs",
        "/tmp:rw,nosuid,nodev,size=256m",
        "--env",
        "HOME=/tmp",
        "--env",
        "PATH=/usr/local/bin:/usr/bin:/bin",
        "--mount",
        `type=bind,source=${workspace},target=/workspace`,
        "-i",
        image,
      ],
  {
    cwd: workspace,
    env: { ...scrubWorkerEnv(process.env), ...(workerPaths.host ? { CLAW_WORKER_WORKSPACE: workspace } : {}) },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  },
);
let diagnostic = "";
child.stderr.on("data", (c) => (diagnostic += c.toString().slice(0, 4000)));
const closed = new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
const frames = boundedLines(child.stdout);
let id = 0;
async function rpc(method, params = {}) {
  const requestId = String(++id);
  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }) + "\n");
  while (true) {
    const next = await frames.next();
    if (next.done) break;
    const response = JSON.parse(next.value);
    if (response.id !== requestId) continue;
    if (response.error) throw new Error(`${method}: ${response.error.message}`);
    return response.result;
  }
  throw new Error("worker_closed " + diagnostic);
}
try {
  child.stdin.write(JSON.stringify(request) + "\n");
  while (true) {
    const next = await frames.next();
    if (next.done) throw new Error("no_ready " + diagnostic);
    const value = JSON.parse(next.value);
    if (value.method === "ready") break;
  }
  // Calling iterator.return would close its generator: consume individual next() instead.
  console.log(JSON.stringify({ workspace, name, event: "ready" }));
  const skill = await rpc("read_file", { path: "/opt/skills/video-shotcraft/SKILL.md" });
  assert.match(skill.content, /video-shotcraft/);
  assert.equal(skill.nextOffset, undefined);
  const cardsRoot = "/opt/skills/video-shotcraft/references/shots/ui-entrance";
  const cards = await rpc("list_files", { path: cardsRoot });
  assert.ok(cards.files.some((file) => file.name === "row-embed.md"));
  const matches = await rpc("search_files", { path: cardsRoot, query: "row-embed" });
  assert.ok(matches.matches.some((match) => match.path === "row-embed.md"));
  const card = await rpc("read_file", { path: `${cardsRoot}/row-embed.md`, limit: 80 });
  assert.equal(card.nextOffset, 80);
  const source =
    "import React from 'react';\nimport {Composition,registerRoot,useCurrentFrame} from 'remotion';\nimport {mix} from './demos/_fixtures/Polish';\nconst Shot:React.FC=()=>{const f=useCurrentFrame();return <div style={{width:'100%',height:'100%',display:'flex',alignItems:'center',justifyContent:'center',fontFamily:'Noto Sans',fontSize:64,color:'white',background:'#162527',opacity:mix(0.3,1,Math.min(f/12,1))}}>Xin chào Việt Nam</div>};\nconst Root:React.FC=()=> <Composition id=\"ProductionShot\" component={Shot} width={1280} height={720} fps={30} durationInFrames={30}/>;\nregisterRoot(Root);";
  await rpc("write_file", { path: "entry.tsx", content: source });
  await rpc("apply_patch", { path: "entry.tsx", oldText: "#162527", newText: "#172628" });
  const checked = await rpc("typecheck");
  assert.equal(checked.ok, true, checked.output);
  const still = await rpc("render_still", { frame: 15 });
  assert.equal(still.mimeType, "image/jpeg");
  assert.ok(still.image.length > 1000);
  const video = await rpc("render_video");
  assert.ok(video.byteSize > 64);
  const media = await rpc("inspect_media");
  assert.equal(media.ok, true, media.output);
  const stream = JSON.parse(media.output).streams.find((item) => item.codec_name === "h264");
  assert.equal(stream?.width, 1280);
  assert.equal(stream.height, 720);
  assert.equal(stream.avg_frame_rate, "30/1");
  assert.equal(Number(stream.nb_frames), 30);
  const finished = await rpc("finish");
  child.stdin.end();
  assert.equal(await closed, 0, diagnostic);
  const data = await readFile(path.join(workspace, finished.sourceArchiveOutput));
  assert.equal(createHash("sha256").update(data).digest("hex"), finished.sourceArchiveSha256);
  assert.ok(JSON.parse(data).files.some((f) => f.path === "demos/_fixtures/Polish.tsx"));
  if (!workerPaths.host) {
    const info = JSON.parse(execFileSync("docker", ["inspect", name], { encoding: "utf8", windowsHide: true }))[0];
    assert.equal(info.HostConfig.NetworkMode, "none");
    assert.equal(info.Config.User, "65532:65532");
    assert.equal(info.HostConfig.ReadonlyRootfs, true);
  }
  console.log(
    JSON.stringify({
      workspace,
      name,
      event: "passed",
      videoBytes: video.byteSize,
      archiveBytes: data.length,
      frames: 30,
      sha256: finished.sha256,
    }),
  );
} finally {
  child.stdin.end();
  try {
    if (!workerPaths.host)
      execFileSync("docker", ["rm", "-f", name], { stdio: "ignore", windowsHide: true, timeout: 15_000 });
  } catch {
    // A failed Docker launch may never create the fixture container.
  }
}
