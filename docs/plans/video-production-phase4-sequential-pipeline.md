# Phase 4 — Sequential production execution and media pipeline

Implementation is integrated and has passed local pipeline and worker fixtures. Live configuration and deployment verification remain pending. Phase 1–3 are preserved at baseline commit `71a15f0`.

## Scope and security decisions

- Nine existing stage keys remain the source of order/dependency metadata. Phase 4 ships fixed server-owned dispatch adapters for implemented stages; activation remains fail-closed until operator configuration, immutable image verification and isolation readiness pass. Never accept a request-supplied command/provider.
- Reuse Phase 1 atomic task/attempt/slot claims, recovery and exact attempt ownership; Phase 2 role/project grants and capability resolver; Phase 3 immutable Scene/Shot/Take/Asset/Manifest records.
- Worker containers remain non-root, networkless, read-only except bounded attempt workspace, and without home, host repo, DB, Docker socket, CEO session, provider credentials or host filesystem access. No shell/body-supplied command. Worker emits bounded typed events/results only.
- For remote LLM-dependent work, a server-side broker validates active `(project, stage, task, attempt, assigned agent, plan version, action)` before calling the existing provider implementation. It does not expose server/provider credentials to the worker. No live provider call is part of local tests.
- The renderer/TTS subprocess lifecycle must be tied to the attempt. A verified worker exit enters output-validation pending while its attempt/slot remains owned. Validate and import exact outputs first; only then transactionally complete/review-gate and release. Unknown exit, missing output, invalid media, import failure, or stale attempt never marks success.
- CEO remains the only final release authority using existing authenticated CEO + CSRF transport. Agent review identities are server-resolved scoped capabilities; no browser credential, actor dropdown, request-body identity, or automatic approval.
- Regeneration is specific to a rejected/unapproved shot and never mutates an approved shot/take/asset. It does not launch a generic unsupported task.

## Stage responsibilities

1. Intake and planning — Dami; existing CEO plan approval.
2. Story development — Haru proposes script/scenes/shots through typed outputs; Rian approves or requests changes.
3. Visual pre-production — Yuna owns style/reference/continuity; approval applies to exact versions.
4. Audio pre-production — audio producer prepares timing/narration plan; reuse local VieNeu TTS only through a controlled attempt-scoped adapter.
5. Footage production — Miro produces one Remotion composition per assigned shot and registers immutable source/render/metadata outputs. No external video provider is required.
6. Asset handoff and rough cut — Liam composes approved shots once into a single Remotion timeline, transitions, subtitles and synchronized narration.
7. Director review — Rian approves or requests targeted shot changes.
8. Finishing and QA — Quinn performs independent technical/content QA and reports actual defects. No fake pass.
9. Release and archive — a CEO explicitly approves the exact validated immutable manifest; no agent may release.

Only sequential single-task execution is in scope; no parallel delegation/new task manager/chat orchestration is added.

## Output validation

- Stage results bind exact project/scene/shot/spec/take/attempt/plan identities and immutable registry asset IDs/hashes. Client/worker claims do not prove file identity.
- Media bytes are validated by actual hash, bounded size, recognized file signature, Remotion render metadata and bundled ffprobe/ffmpeg decode where relevant. MP4 validation requires video stream, expected dimensions/frame rate, expected duration bounds, successful full decode, and audio stream/cue timing for narrated output. File existence or process exit is insufficient.
- Store each shot render and source assets immutably. Final timeline reuses approved per-shot renders instead of rendering each shot again. The manifest pins exact approved shot/take/assets and is immutable. CEO release operates on that manifest version.
- CEO release must additionally pin the exact final MP4 asset/hash, input shot-manifest digest, audio/cues version, timeline version and Quinn QA evidence for that exact final hash. A previously approved shot manifest cannot release a changed final file.
- Source Remotion TS, screenplay and timing/cue documents are typed immutable stage artifacts, not image/video assets. Imports bind them to project/stage/task/attempt/plan and relevant scene/shot versions.
- Reuse `@remotion/renderer`, `@remotion/bundler`, and bundled compositor tools through `createRequire(require.resolve('@remotion/cli/package.json'))`. Host fixtures use the installed local browser and skip the browser bootstrap. The disposable Docker test image installs its own Chromium and Remotion dependencies at build time and runs with networking disabled.

## Verification plan

- Real SQLite/middleware tests: sequential unlock only after valid reviewed outputs; stale attempt, spoofed identity, cross-project asset, worker exit zero without artifact, bad signature/hash/stream/duration, failed import, duplicate callback, retry and restart never fake completion.
- Broker tests use fake model adapters and assert stage/action/attempt context, output schema/size bounds, no secret forwarded, and no arbitrary command or path accepted.
- TTS tests use fake synthesis at the seam; any actual local TTS run is optional only when a preinstalled model is available, never download one.
- Current audit found no local VieNeu model files or dedicated Python environment. The production adapter must fail with a structured unavailable status; tests may inject deterministic synthesis but must not label test tones as TTS speech.
- Remotion fixture uses trusted local source/composition and bundled local browser/compositor only; renders a tiny MP4 offline, runs full decode/probe, validates audio stream/sync and hashes, then removes isolated temp outputs. No arbitrary model-generated composition executes on host.
- Failure/unknown states retain or safely reconcile the exact slot. Workspace cleanup occurs only after verified output import or verified safe failure, never before validation.
- Full backend/frontend tests, tsc, build, lint, OpenAPI and diff checks after source freeze; root independently validates.

## Audit correction

Initial audit incorrectly treated top-level `node_modules/@remotion/renderer` and host PATH as complete availability checks. Remotion CLI 4.0.429 has renderer and bundler dependencies in its pnpm virtual store; compositor package includes ffmpeg/ffprobe binaries, and local Chrome is present. Resolve all via a `createRequire` based at `require.resolve('@remotion/cli/package.json')`. Do not execute browser ensure/download.
