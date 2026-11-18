import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../api";
import type { WSEventType } from "../types";
import { useRealtimeSync } from "./useRealtimeSync";

vi.mock("../api", () => ({ getDepartments: vi.fn() }));

afterEach(() => vi.clearAllMocks());

function params(on: (event: WSEventType, handler: (payload: unknown) => void) => () => void, activeWorkflowPack: "development" | "video_production", setDepartments = vi.fn()) {
  const ref = <T,>(current: T) => ({ current });
  const noop = vi.fn();
  return {
    on,
    scheduleLiveSync: noop,
    agentsRef: ref([]), tasksRef: ref([]), subAgentsRef: ref([]), viewRef: ref("dashboard" as never),
    activeChatRef: ref({ showChat: false, agentId: null }), codexThreadToSubAgentIdRef: ref(new Map()),
    codexThreadBindingTsRef: ref(new Map()), subAgentStreamTailRef: ref(new Map()),
    setAgents: noop, setDepartments, setMessages: noop, setUnreadAgentIds: noop, setTaskReport: noop,
    setCrossDeptDeliveries: noop, setCeoOfficeCalls: noop, setMeetingPresence: noop, setSubtasks: noop,
    setSubAgents: noop, setStreamingMessage: noop, activeWorkflowPack,
  } as never as Parameters<typeof useRealtimeSync>[0];
}

describe("Video Production realtime department refresh", () => {
  it("refreshes only the active Video Production pack and ignores late responses after unmount", async () => {
    const listeners = new Map<WSEventType, (payload: unknown) => void>();
    const on = (event: WSEventType, handler: (payload: unknown) => void) => {
      listeners.set(event, handler);
      return () => listeners.delete(event);
    };
    const setDepartments = vi.fn();
    let resolveDepartments!: (value: never[]) => void;
    vi.mocked(api.getDepartments).mockReturnValue(new Promise((resolve) => { resolveDepartments = resolve; }) as never);
    const { unmount } = renderHook(() => useRealtimeSync(params(on, "video_production", setDepartments)));
    act(() => listeners.get("departments_changed")?.({ workflow_pack_key: "development" }));
    expect(api.getDepartments).not.toHaveBeenCalled();
    act(() => listeners.get("departments_changed")?.({ workflow_pack_key: "video_production" }));
    expect(api.getDepartments).toHaveBeenCalledWith({ workflowPackKey: "video_production" });
    unmount();
    await act(async () => { resolveDepartments([]); await Promise.resolve(); });
    expect(setDepartments).not.toHaveBeenCalled();
  });

  it("keeps legacy department refresh handling scoped to its existing scheduling path", () => {
    const listeners = new Map<WSEventType, (payload: unknown) => void>();
    const on = (event: WSEventType, handler: (payload: unknown) => void) => { listeners.set(event, handler); return () => listeners.delete(event); };
    renderHook(() => useRealtimeSync(params(on, "development")));
    act(() => listeners.get("departments_changed")?.({ workflow_pack_key: "development" }));
    expect(api.getDepartments).not.toHaveBeenCalled();
  });
});
