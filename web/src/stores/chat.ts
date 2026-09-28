/**
 * Sansheng Chat Store · Zustand
 *
 * 单一对话流(M1);M3+ 拆多会话。
 */
import { create } from "zustand";
import type { ServerEvent } from "@shared/types/ws";

export type Role = "user" | "assistant" | "system";

export type Block =
  | { kind: "thinking"; text: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: { id: string; name: string; args?: unknown; result?: unknown; isError?: boolean; durationMs?: number } };

export interface Turn {
  id: string;
  role: Role;
  blocks: Block[];
  startedAt: number;
  endedAt?: number;
  usage?: { input: number; output: number };
  isStreaming?: boolean;
  errorText?: string;
}

export interface ChatState {
  conversationId: string | null;
  modelId: string | null;
  provider: string | null;
  status: "idle" | "streaming" | "error";
  turns: Turn[];
  currentTurn: Turn | null;
  currentUsage: { input: number; output: number; costUsd: number };
  totalUsage: { input: number; output: number; costUsd: number };
  error: { code: string; message: string } | null;

  // mutations
  reset(): void;
  applyEvent(e: ServerEvent): void;
  appendUserTurn(text: string): void;
}

const newTurn = (id: string, role: Role): Turn => ({
  id,
  role,
  blocks: [],
  startedAt: Date.now(),
  isStreaming: false,
});

export const useChatStore = create<ChatState>((set, get) => ({
  conversationId: null,
  modelId: null,
  provider: null,
  status: "idle",
  turns: [],
  currentTurn: null,
  currentUsage: { input: 0, output: 0, costUsd: 0 },
  totalUsage: { input: 0, output: 0, costUsd: 0 },
  error: null,

  reset() {
    set({
      turns: [],
      currentTurn: null,
      currentUsage: { input: 0, output: 0, costUsd: 0 },
      error: null,
      status: "idle",
    });
  },

  appendUserTurn(text: string) {
    const t = newTurn(`u_${Date.now().toString(36)}`, "user");
    set((s) => ({ turns: [...s.turns, { ...t, blocks: [{ kind: "text", text }] }] }));
  },

  applyEvent(e: ServerEvent) {
    const state = get();
    switch (e.type) {
      case "ready":
        set({
          conversationId: e.conversationId,
          modelId: e.modelId,
          provider: e.provider,
          error: null,
          status: "idle",
        });
        return;
      case "agent_start":
        set({ status: "streaming", error: null });
        return;
      case "turn_start": {
        const turn = newTurn(`as_${e.turnIndex}_${Date.now().toString(36)}`, "assistant");
        set({ currentTurn: turn, status: "streaming", error: null });
        return;
      }
      case "message_start": {
        const cur = get().currentTurn;
        if (!cur) return;
        // if the role matches; user input is shown but not "started" via WS
        return;
      }
      case "delta": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "text") {
          blocks[blocks.length - 1] = { kind: "text", text: last.text + e.text };
        } else {
          blocks.push({ kind: "text", text: e.text });
        }
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "thinking_delta": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = [...cur.blocks];
        const last = blocks[blocks.length - 1];
        if (last && last.kind === "thinking") {
          blocks[blocks.length - 1] = { kind: "thinking", text: last.text + e.text };
        } else {
          blocks.push({ kind: "thinking", text: e.text });
        }
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "tool_start": {
        const cur = get().currentTurn;
        if (!cur) return;
        set({
          currentTurn: {
            ...cur,
            blocks: [...cur.blocks, { kind: "tool", tool: { id: e.tool.id, name: e.tool.name, args: e.tool.args } }],
          },
        });
        return;
      }
      case "tool_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        const blocks = cur.blocks.map((b) =>
          b.kind === "tool" && b.tool.id === e.tool.id
            ? {
                kind: "tool" as const,
                tool: {
                  ...b.tool,
                  result: e.tool.result,
                  isError: e.tool.isError,
                  durationMs: e.tool.durationMs,
                },
              }
            : b,
        );
        set({ currentTurn: { ...cur, blocks } });
        return;
      }
      case "message_end": {
        const cur = get().currentTurn;
        if (!cur) return;
        set({
          currentTurn: { ...cur, usage: e.usage, isStreaming: false },
        });
        return;
      }
      case "agent_end": {
        const cur = get().currentTurn;
        const turns = cur ? [...state.turns, { ...cur, endedAt: Date.now(), isStreaming: false }] : state.turns;
        const totalInput = state.totalUsage.input + (e.usage?.input ?? 0);
        const totalOutput = state.totalUsage.output + (e.usage?.output ?? 0);
        const totalCost = state.totalUsage.costUsd + (e.usage?.costUsd ?? 0);
        set({
          turns,
          currentTurn: null,
          currentUsage: { input: 0, output: 0, costUsd: 0 },
          totalUsage: { input: totalInput, output: totalOutput, costUsd: totalCost },
          status: "idle",
        });
        return;
      }
      case "error":
        set({ status: "error", error: e.error });
        return;
      case "interrupt":
        set({ status: "idle" });
        return;
    }
  },
}));