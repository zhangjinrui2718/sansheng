/**
 * Sansheng WS 协议类型(M1)
 */
export type ServerEvent =
  | { type: "ready"; conversationId: string; modelId: string; provider: string }
  | { type: "agent_start"; conversationId: string; ts: number }
  | { type: "turn_start"; conversationId: string; turnIndex: number; ts: number }
  | { type: "message_start"; conversationId: string; message: { role: "user" | "assistant"; id: string } }
  | { type: "delta"; conversationId: string; messageId: string; text: string }
  | { type: "thinking_delta"; conversationId: string; messageId: string; text: string }
  | { type: "message_end"; conversationId: string; messageId: string; usage?: { input: number; output: number } }
  | {
      type: "tool_start";
      conversationId: string;
      messageId: string;
      tool: { id: string; name: string; args: unknown };
    }
  | {
      type: "tool_end";
      conversationId: string;
      messageId: string;
      tool: { id: string; name: string; result: unknown; isError: boolean; durationMs?: number };
    }
  | {
      type: "agent_end";
      conversationId: string;
      ts: number;
      usage?: { input: number; output: number; costUsd: number };
    }
  | { type: "error"; conversationId: string; error: { code: string; message: string } }
  | { type: "interrupt"; conversationId: string }
  | { type: "conversation_reset"; conversationId: string }
  | { type: "title_changed"; conversationId: string; title: string }
  // M3c: Communicator / MessageBus
  | {
      type: "bus_event";
      message: import("./agents.js").BusMessage;
    }
  | {
      type: "communicator_thinking";
      conversationId: string;
      status: "idle" | "thinking" | "tool_use";
    }
  | {
      type: "pending_question";
      conversationId: string;
      questionId: string;
      payload: string;
      fromRole: import("./agents.js").RoleId;
    }
  // M3+ BlackboardArtifact lifecycle (forwarded from artifactBus)
  | {
      type: "artifact_created";
      artifact: import("./blackboard.js").BlackboardArtifact;
    }
  | {
      type: "artifact_status_changed";
      artifactId: string;
      oldStatus: import("./blackboard.js").ArtifactStatus;
      newStatus: import("./blackboard.js").ArtifactStatus;
      actor?: import("./blackboard.js").ArtifactAuthor;
    }
  | {
      type: "executor_callback";
      executorSessionId: string;
      hypothesisId: string;
      reason: import("./blackboard.js").CallbackReason;
    }
  | {
      type: "executor_resume";
      executorSessionId: string;
      decisionArtifactId: string;
    }
  | {
      type: "harness_proposal_created";
      artifact: import("./blackboard.js").BlackboardArtifact;
    }
  // M3+ B2 · 批次 1 B10-5 前端接线:Orchestrator plan 完成/失败。
  // ⚠️ 镜像关系:server 侧的 ServerEvent 真身定义在 src/server/kernel/agentKernel.ts
  // (server 端不能 value-import @shared/*,所以两边各自定义)— 下面的字段形状
  // 必须与 agentKernel.ts 的 plan_done/plan_failed 成员**逐字一致**,改动需两边同步。
  // 消费方:web/src/stores/chat.ts applyEvent(plan_done → summary 追加为可见消息;
  // plan_failed → 追加错误消息 + error 状态)。
  | {
      type: "plan_done";
      conversationId: string;
      intentId: string;
      summary: string;
      artifacts?: import("./blackboard.js").BlackboardArtifact[];
      /**
       * 批次 7-I(B):交付物子集 —— resolved 的 evidence 正文。
       * 与 `artifacts`(整块 blackboard,工件 tab 用)分开:**交付物是给人看的产物**,
       * artifacts 是给人查的系统状态。两者不互相替代。
       */
      deliveries?: import("./chat.js").DeliveryItem[];
    }
  | {
      type: "plan_failed";
      conversationId: string;
      intentId?: string;
      message: string;
    };

export type ClientCommand =
  | { type: "send"; content: string; conversationId?: string }
  | { type: "interrupt" }
  | { type: "ping" }
  | { type: "load_conversation"; conversationId: string }
  // M3b: 多 agent / Blackboard
  | { type: "plan"; goal: string; conversationId: string }
  | { type: "abort_plan" }
  // M3c: Communicator ↔ MessageBus
  | { type: "answer_question"; questionId: string; payload: string; conversationId: string }
  | { type: "cancel_question"; questionId: string; conversationId: string }
  | { type: "bus_replay"; conversationId: string; fromTs: number };