import type { ChildProcess } from "node:child_process";
import type { DatabaseSync } from "node:sqlite";
import type { WebSocket as WsSocket, WebSocketServer } from "ws";
import { isManagedVideoProductionTask } from "../workflow/video-production.ts";

interface RegisterGracefulShutdownHandlersOptions {
  activeProcesses: Map<string, ChildProcess>;
  stopRequestedTasks: Set<string>;
  killPidTree: (pid: number) => void;
  rollbackTaskWorktree: (taskId: string, reason: string) => void;
  db: DatabaseSync;
  appendTaskLog?: (taskId: string, kind: string, message: string) => void;
  nowMs: () => number;
  endTaskExecutionSession: (taskId: string, reason: string) => void;
  wsClients: Set<WsSocket>;
  wss: WebSocketServer;
  server: { close: (callback: () => void) => void };
  onBeforeClose?: () => void;
}

export function registerGracefulShutdownHandlers({
  activeProcesses,
  stopRequestedTasks,
  killPidTree,
  rollbackTaskWorktree,
  db,
  appendTaskLog,
  nowMs,
  endTaskExecutionSession,
  wsClients,
  wss,
  server,
  onBeforeClose,
}: RegisterGracefulShutdownHandlersOptions): void {
  function gracefulShutdown(signal: string): void {
    console.log(`\n[Claw-Empire] ${signal} received. Shutting down gracefully...`);

    try {
      onBeforeClose?.();
    } catch {
      // ignore pre-close cleanup failures
    }

    for (const [taskId, child] of activeProcesses) {
      if (isManagedVideoProductionTask(db as any, taskId)) {
        db.prepare(
          "UPDATE video_production_attempts SET state='RECONCILIATION_REQUIRED',updated_at=? WHERE task_id=? AND state IN ('PREPARED','LAUNCHING','RUNNING')",
        ).run(nowMs(), taskId);
        appendTaskLog?.(taskId, "system", "Production shutdown: worker identity retained for reconciliation; no broad process kill or reservation release was performed.");
        activeProcesses.delete(taskId);
        continue;
      }
      console.log(`[Claw-Empire] Stopping process for task ${taskId} (pid: ${child.pid})`);
      stopRequestedTasks.add(taskId);
      if (child.pid) {
        killPidTree(child.pid);
      }
      activeProcesses.delete(taskId);

      rollbackTaskWorktree(taskId, "server_shutdown");

      const task = db.prepare("SELECT assigned_agent_id FROM tasks WHERE id = ?").get(taskId) as
        | {
            assigned_agent_id: string | null;
          }
        | undefined;
      if (task?.assigned_agent_id) {
        db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(
          task.assigned_agent_id,
        );
      }
      db.prepare("UPDATE tasks SET status = 'cancelled', updated_at = ? WHERE id = ? AND status = 'in_progress'").run(
        nowMs(),
        taskId,
      );
      endTaskExecutionSession(taskId, "server_shutdown");
    }

    for (const ws of wsClients) {
      ws.close(1001, "Server shutting down");
    }
    wsClients.clear();

    wss.close(() => {
      server.close(() => {
        try {
          db.close();
        } catch {
          /* ignore */
        }
        console.log("[Claw-Empire] Shutdown complete.");
        process.exit(0);
      });
    });

    setTimeout(() => {
      console.error("[Claw-Empire] Forced exit after timeout.");
      process.exit(1);
    }, 5000).unref();
  }

  process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));

  process.once("SIGUSR2", () => {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.kill(process.pid, "SIGUSR2");
  });
}
