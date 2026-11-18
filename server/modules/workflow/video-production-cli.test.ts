import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("../../config/runtime.ts", async (original) => ({ ...await original<any>(), CLI_WORKER_RUNTIME_MODE: "host" }));
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { requestVideoCliJson, type VideoCli } from "./video-production-cli.ts";
import { scrubVideoHostEnv } from "./video-production-host.ts";
import { getVideoProductionAgentProvider, requestVideoProductionJson } from "./video-production-provider-broker.ts";
const originalEnv = { ...process.env };
afterEach(() => {
  process.env = { ...originalEnv };
});
describe("logged-in video CLI boundary", () => {
  it("removes server secrets and preserves login directories", () => {
    expect(
      scrubVideoHostEnv({
        api_auth_token: "secret",
        SESSION_AUTH_TOKEN: "secret",
        INBOX_WEBHOOK_SECRET: "secret",
        OAUTH_ENCRYPTION_SECRET: "secret",
        HOME: "home",
        USERPROFILE: "user",
        APPDATA: "app",
        LOCALAPPDATA: "local",
        PATH: "path",
      }),
    ).toEqual({ HOME: "home", USERPROFILE: "user", APPDATA: "app", LOCALAPPDATA: "local", PATH: "path" });
  });
  it.each(["codex", "claude", "gemini"] as VideoCli[])(
    "uses noninteractive %s and parses only the final JSON",
    async (provider) => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), "claw-cli-test-"));
      try {
        const pkg = { codex: "@openai/codex", claude: "@anthropic-ai/claude-code", gemini: "@google/gemini-cli" }[
          provider
        ];
        const dir = path.join(root, "node_modules", pkg);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({ bin: { [provider]: "cli.cjs" } }));
        await fs.writeFile(
          path.join(dir, "cli.cjs"),
          `const fs=require('fs');let input='';process.stdin.on('data',c=>input+=c);process.stdin.on('end',()=>{const args=process.argv.slice(2);const value={input,args,secret:process.env.API_AUTH_TOKEN??null,home:process.env.HOME??null};const text=JSON.stringify(value);const i=args.indexOf('--output-last-message');if(i>=0)fs.writeFileSync(args[i+1],text);else console.log(JSON.stringify({result:text}));});`,
        );
        process.env.PATH = root;
        process.env.API_AUTH_TOKEN = "do-not-leak";
        const selected = getVideoProductionAgentProvider(
          {
            prepare: () => ({ get: () => ({ cli_provider: provider, api_provider_id: null, cli_model: null }) }),
          } as any,
          "agent",
        );
        const result = (await requestVideoProductionJson({
          ...selected,
          prompt: "Produce typed scene",
          images: [{ mimeType: "image/png", data: Buffer.from("image").toString("base64") }],
        })) as any;
        expect(result.secret).toBeNull();
        expect(result.input).toContain("never call CEO approval/decision/release endpoints");
        expect(result.args.join(" ")).toContain(
          provider === "codex" ? "read-only" : provider === "claude" ? "--tools=" : "plan",
        );
        expect(result.args.join(" ")).not.toContain("yolo");
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    },
  );
});
