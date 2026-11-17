import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createRunCompleteHandler } from "./run-complete-handler.ts";
import * as vieneu from "../packs/vieneu-tts.ts";
import { VOICEOVER_MARKER, voiceoverPaths } from "../packs/video-voiceover.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      task_type TEXT,
      workflow_pack_key TEXT,
      project_id TEXT,
      project_path TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      department_id TEXT,
      result TEXT,
      updated_at INTEGER DEFAULT 0
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      title TEXT,
      status TEXT NOT NULL,
      target_department_id TEXT,
      delegated_task_id TEXT,
      cli_tool_use_id TEXT,
      completed_at INTEGER,
      blocked_reason TEXT
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      status TEXT,
      current_task_id TEXT,
      department_id TEXT,
      stats_tasks_done INTEGER DEFAULT 0,
      stats_xp INTEGER DEFAULT 0
    );
  `);
  return db;
}

function createDeps(db: DatabaseSync, logsDir = "/tmp") {
  return {
    activeProcesses: new Map<string, unknown>(),
    stopProgressTimer: vi.fn(),
    getNextHttpAgentPid: () => -1,
    db,
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "pause" | "cancel">(),
    appendTaskLog: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    codexThreadToSubtask: new Map<string, string>(),
    nowMs: () => 1700000000000,
    logsDir,
    broadcast: vi.fn(),
    processSubtaskDelegations: vi.fn(),
    taskWorktrees: new Map<string, { worktreePath?: string; projectPath?: string; branchName?: string }>(),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn(() => "팀장"),
    pickL: (pool: any) => {
      if (Array.isArray(pool?.ko)) return pool.ko[0];
      if (Array.isArray(pool?.en)) return pool.en[0];
      if (Array.isArray(pool)) return pool[0];
      return "";
    },
    l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => ({ ko, en, ja: ja ?? en, zh: zh ?? en }),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    resolveLang: vi.fn(() => "ko"),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    finishReview: vi.fn(),
    reconcileDelegatedSubtasksAfterRun: vi.fn(),
    completeTaskWithoutReview: vi.fn(),
    isReportDesignCheckpointTask: vi.fn(() => false),
    extractReportDesignParentTaskId: vi.fn(() => null),
    resumeReportAfterDesignCheckpoint: vi.fn(),
    isPresentationReportTask: vi.fn(() => false),
    readReportFlowValue: vi.fn(() => null),
    startReportDesignCheckpoint: vi.fn(() => false),
    upsertReportFlowValue: vi.fn((desc: string | null) => desc ?? ""),
    isReportRequestTask: vi.fn(() => false),
    notifyTaskStatus: vi.fn(),
    prettyStreamJson: vi.fn((raw: string) => raw),
    getWorktreeDiffSummary: vi.fn(() => ""),
    hasVisibleDiffSummary: vi.fn(() => false),
  } as any;
}

describe("run complete handler - video preprod review transition", () => {
  it.each([true, false])(
    "keeps the delegated narration open until backend synthesis finishes (success=%s)",
    async (success) => {
      const db = createDb();
      const project = fs.mkdtempSync(path.join(os.tmpdir(), "claw-audio-completion-"));
      const parent = "parent-video";
      const taskId = "child-audio";
      const worktree = path.join(project, "audio-worktree");
      const paths = voiceoverPaths(parent);
      let finishGeneration: () => void = () => {};
      const generator = vi.spyOn(vieneu, "generateVieNeuSpeech").mockImplementation(
        ({ outputPath }) =>
          new Promise((resolve, reject) => {
            finishGeneration = () => {
              if (!success) return reject(new vieneu.VieNeuTtsError("unavailable"));
              fs.writeFileSync(path.join(project, outputPath), "mock mp3");
              resolve({
                outputPath,
                bytes: 8,
                durationSeconds: 1.25,
                voice: "Minh Quân",
                cues: [{ text: "Xin chào", startSeconds: 0, endSeconds: 1.25 }],
                engine: "vieneu-tts",
              });
            };
          }),
      );
      try {
        db.prepare(
          `INSERT INTO tasks (id, title, status, workflow_pack_key, source_task_id, project_path, department_id)
                  VALUES (?, ?, 'in_progress', 'video_preprod', ?, ?, 'voice_audio')`,
        ).run(taskId, VOICEOVER_MARKER, parent, project);
        db.prepare(
          `INSERT INTO subtasks (id, title, task_id, status, target_department_id, delegated_task_id)
                  VALUES ('voice-subtask', ?, ?, 'in_progress', 'voice_audio', ?)`,
        ).run(VOICEOVER_MARKER, parent, taskId);
        fs.mkdirSync(path.dirname(path.join(project, paths.script)), { recursive: true });
        fs.mkdirSync(path.dirname(path.join(worktree, paths.settings)), { recursive: true });
        fs.writeFileSync(path.join(project, paths.script), "Xin chào");
        fs.writeFileSync(path.join(worktree, paths.settings), JSON.stringify({ speed: 0.95 }));
        const deps = createDeps(db, project);
        deps.taskWorktrees.set(taskId, { projectPath: project, worktreePath: worktree });
        const handler = createRunCompleteHandler(deps);
        handler.handleTaskRunComplete(taskId, 0);
        handler.handleTaskRunComplete(taskId, 0);
        expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "in_progress" });
        expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
        expect(generator).toHaveBeenCalledOnce();
        expect(generator).toHaveBeenCalledWith(expect.objectContaining({ text: "Xin chào", speed: 0.95 }));
        finishGeneration();
        await vi.waitFor(() =>
          expect(db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({
            status: success ? "review" : "inbox",
          }),
        );
        if (success) {
          expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledWith(taskId, 0);
          expect(deps.processSubtaskDelegations).toHaveBeenCalledWith(parent, { includeRender: true });
        } else {
          expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledWith(taskId, 89);
          expect(deps.processSubtaskDelegations).not.toHaveBeenCalled();
        }
      } finally {
        generator.mockRestore();
        db.close();
        fs.rmSync(project, { recursive: true, force: true });
      }
    },
  );
  it("루트 video_preprod는 서브태스크가 남아도 성공 시 review로 진입한다", () => {
    const db = createDb();
    try {
      const taskId = "task-root-video";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', NULL, ?, 'planning', 'project-1', ?, 1)
        `,
      ).run(taskId, "메인 영상 제작", "영상 소개 제작", "video-preprod-seed-1", "/tmp/project");
      db.prepare(
        `
          INSERT INTO subtasks (id, task_id, status, target_department_id, delegated_task_id, cli_tool_use_id)
          VALUES ('sub-1', ?, 'pending', 'dev', NULL, NULL)
        `,
      ).run(taskId);
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-1', 'Haru', '하루', 'working', ?, 'planning', 0, 0)
        `,
      ).run(taskId);

      const deps = createDeps(db);
      deps.activeProcesses.set(taskId, { pid: 101 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("Video sequencing notice: documentation/collaboration still in progress"),
      );
      expect(deps.notifyTaskStatus).toHaveBeenCalledWith(taskId, "메인 영상 제작", "review", "ko");
      expect(deps.notifyTaskStatus.mock.calls.some((call: any[]) => call[0] === taskId && call[2] === "pending")).toBe(
        false,
      );
    } finally {
      db.close();
    }
  });

  it("협업 자식 video_preprod는 산출물 게이트 없이 review로 진입한다", () => {
    const db = createDb();
    try {
      const taskId = "task-child-video";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', 'parent-task', ?, 'dev', 'project-1', ?, 1)
        `,
      ).run(taskId, "개발팀 영상 보완", "영상 컷 보완", "video-preprod-seed-2", "/tmp/project");
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-2', 'Liam', '리암', 'working', ?, 'dev', 0, 0)
        `,
      ).run(taskId);

      const deps = createDeps(db);
      deps.activeProcesses.set(taskId, { pid: 102 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledWith(taskId, 0);

      const loggedMessages = deps.appendTaskLog.mock.calls.map((call: any[]) => String(call[2] ?? ""));
      expect(loggedMessages.some((message: string) => message.includes("Video artifact"))).toBe(false);
      expect(loggedMessages.some((message: string) => message.includes("Video sequencing notice"))).toBe(false);
    } finally {
      db.close();
    }
  });

  it("[VIDEO_FINAL_RENDER]는 Remotion 증빙이 없으면 성공 종료여도 실패 처리한다", () => {
    const db = createDb();
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-run-complete-"));
    try {
      const taskId = "task-final-render";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', 'parent-task', ?, 'dev', 'project-1', ?, 1)
        `,
      ).run(taskId, "[VIDEO_FINAL_RENDER] 최종 영상 렌더링", "최종 렌더링", "video-preprod-seed-2", "/tmp/project");
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-2', 'Liam', '리암', 'working', ?, 'dev', 0, 0)
        `,
      ).run(taskId);
      fs.writeFileSync(path.join(logsDir, `${taskId}.log`), "moviepy 2.1.2 is available", "utf8");

      const deps = createDeps(db, logsDir);
      deps.activeProcesses.set(taskId, { pid: 103 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("inbox");
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("Video render engine gate failed"),
      );
      expect(
        deps.appendTaskLog.mock.calls.some((call: any[]) =>
          String(call[2] ?? "").includes("RUN failed (exit code: 86)"),
        ),
      ).toBe(true);
    } finally {
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });

  it("[VIDEO_FINAL_RENDER]는 thinking 내 정책 문구가 있어도 Remotion 렌더 증빙이 있으면 실패 처리하지 않는다", () => {
    const db = createDb();
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-run-complete-"));
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-"));
    const projectPath = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-project-"));
    try {
      const taskId = "task-final-render-thinking-ok";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', 'parent-task', ?, 'dev', 'project-1', ?, 1)
        `,
      ).run(taskId, "[VIDEO_FINAL_RENDER] 최종 영상 렌더링", "최종 렌더링", "video-preprod-seed-2", projectPath);
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-2', 'Liam', '리암', 'working', ?, 'dev', 0, 0)
        `,
      ).run(taskId);
      fs.writeFileSync(
        path.join(logsDir, `${taskId}.log`),
        [
          '{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Use Remotion only (no Python/moviepy/Pillow, no ffmpeg standalone)"}}}',
          "pnpm exec remotion render src/index.ts Intro video_output/final.mp4 --log=verbose",
        ].join("\n"),
        "utf8",
      );
      fs.mkdirSync(path.join(worktreeDir, "video_output"), { recursive: true });
      fs.writeFileSync(path.join(worktreeDir, "video_output", "final.mp4"), "rendered-video", "utf8");

      const deps = createDeps(db, logsDir);
      deps.taskWorktrees.set(taskId, { worktreePath: worktreeDir, projectPath, branchName: "climpire/test" });
      deps.activeProcesses.set(taskId, { pid: 105 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(deps.cleanupWorktree).not.toHaveBeenCalled();
      expect(
        deps.appendTaskLog.mock.calls.some((call: any[]) =>
          String(call[2] ?? "").includes("Video render engine gate failed"),
        ),
      ).toBe(false);
    } finally {
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      try {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      try {
        fs.rmSync(projectPath, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });

  it("[VIDEO_FINAL_RENDER]는 렌더 산출물과 Remotion 증빙이 있으면 비정상 종료 코드도 성공으로 복구한다", () => {
    const db = createDb();
    const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-run-complete-"));
    const worktreeDir = fs.mkdtempSync(path.join(os.tmpdir(), "climpire-wt-"));
    try {
      const taskId = "task-final-render-recover";
      const projectPath = "/tmp/project";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', 'parent-task', ?, 'dev', 'project-1', ?, 1)
        `,
      ).run(taskId, "[VIDEO_FINAL_RENDER] 최종 영상 렌더링", "최종 렌더링", "video-preprod-seed-2", projectPath);
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-2', 'Liam', '리암', 'working', ?, 'dev', 0, 0)
        `,
      ).run(taskId);
      fs.writeFileSync(
        path.join(logsDir, `${taskId}.log`),
        "pnpm exec remotion render src/index.ts Intro video_output/final.mp4 --log=verbose",
        "utf8",
      );
      fs.mkdirSync(path.join(worktreeDir, "video_output"), { recursive: true });
      fs.writeFileSync(path.join(worktreeDir, "video_output", "final.mp4"), "rendered-video", "utf8");
      fs.mkdirSync(path.join(projectPath, "video_output"), { recursive: true });

      const deps = createDeps(db, logsDir);
      deps.taskWorktrees.set(taskId, { worktreePath: worktreeDir, projectPath, branchName: "climpire/test" });
      deps.activeProcesses.set(taskId, { pid: 104 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 1);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(
        deps.appendTaskLog.mock.calls.some((call: any[]) =>
          String(call[2] ?? "").includes("Final render recovery: detected valid Remotion output"),
        ),
      ).toBe(true);
      expect(
        deps.appendTaskLog.mock.calls.some((call: any[]) =>
          String(call[2] ?? "").includes("RUN completed (exit code: 0)"),
        ),
      ).toBe(true);
    } finally {
      try {
        fs.rmSync(logsDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      try {
        fs.rmSync(worktreeDir, { recursive: true, force: true });
      } catch {
        // best effort cleanup
      }
      db.close();
    }
  });
});
