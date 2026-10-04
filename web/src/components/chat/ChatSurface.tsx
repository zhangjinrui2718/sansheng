/**
 * 对话面板(旧 `ChatSurface`)
 *
 * ── 相对旧版改了什么 ────────────────────────────────────────────
 *
 *  1. **没有 kernel 了**:旧版头部有「内核卡住了 → ↻ 重置 Kernel」,打的是
 *     `POST /api/kernel/reset` —— 新契约里**没有这条路径**(平台没有 kernel 会话)。
 *     那个按钮已删除;头部改为显示**当前上下文**。
 *  2. **`/plan` 快捷指令删除**:计划概念已删(换成项目经理拆 works),再留一个
 *     `/plan` 前缀就是让用户去发一个不存在的命令。
 *  3. **没有项目也能说话了**(本批次):`ClientCommand.send.projectId` 可为 `null`,
 *     那表示**接待会话** —— 第一个项目之前那段,与你说话的是业务经理。
 *     上一版这里在「没选项目」时禁用输入区并提示「先在左栏选一个项目」,
 *     而用户当时**根本建不了项目**(只能撞上表单校验),于是整个系统在第一个项目
 *     之前是哑的。现在头部显示「接待 · 业务经理」,输入区照常可用。
 *  4. socket 仍由 App 级单例持有(lib/appSocket.ts),本组件只经 store 发命令。
 */
import { useState } from "react";
import { useChatStore } from "@/stores/chat";
import { useSettingsStore, activeProviderOf } from "@/stores/settings";
import { MessageList } from "./MessageList";
import { ChatComposer } from "./ChatComposer";
import { Pill } from "@/components/ui/primitives";
import { projectStatusLabel, projectStatusTone } from "@/lib/vocab";

export function ChatSurface() {
  const [input, setInput] = useState("");
  const status = useChatStore((s) => s.status);
  const provider = useChatStore((s) => s.provider);
  const modelId = useChatStore((s) => s.modelId);
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);
  const projects = useChatStore((s) => s.projects);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const sendInterrupt = useChatStore((s) => s.sendInterrupt);
  const settings = useSettingsStore((s) => s.settings);
  const hasKey = !!activeProviderOf(settings)?.hasApiKey;

  const project = projects.find((p) => p.id === projectId);
  // 有上下文可说话吗:项目内,或接待会话。两者都没有时(有项目但没选)才禁用。
  const hasContext = intakeActive || projectId !== null;

  function send() {
    const text = input.trim();
    if (!text || status === "streaming" || !hasKey || !hasContext) return;
    sendMessage(text);
    setInput("");
  }

  const reason: "streaming" | "noContext" | "noKey" | undefined =
    status === "streaming" ? "streaming" : !hasContext ? "noContext" : !hasKey ? "noKey" : undefined;

  return (
    <section className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="px-4 py-2 flex items-center justify-between flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: 13, color: "var(--bone)" }}>
            {intakeActive ? "接待 · 业务经理" : project ? project.name : "未选项目"}
          </span>
          {intakeActive ? (
            <Pill tone="jade" title="第一个项目之前的那段对话:业务经理与你对齐诉求,谈拢后由他立项">
              谈新项目
            </Pill>
          ) : (
            project && (
              <Pill tone={projectStatusTone(project.status)}>{projectStatusLabel(project.status)}</Pill>
            )
          )}
          <span
            className="sansheng-text-mute truncate"
            style={{ fontSize: 11 }}
            title={provider && modelId ? `${provider} / ${modelId}` : "模型信息来自 WS ready 事件"}
          >
            {provider && modelId ? `${provider} / ${modelId}` : "未连接"}
          </span>
        </div>
        <div className="flex items-center gap-2 flex-none ss-meta">
          <span
            className={
              status === "error"
                ? "sansheng-text-cinnabar"
                : status === "streaming"
                  ? "sansheng-text-jade"
                  : "sansheng-text-mute"
            }
          >
            ● {status === "streaming" ? "推演中" : status === "error" ? "出错" : "就绪"}
          </span>
          {status === "streaming" && (
            <button
              className="sansheng-button"
              style={{ padding: "2px 8px", fontSize: 11 }}
              onClick={sendInterrupt}
              title="中断当前上下文正在跑的这一轮(等价于 Esc)"
            >
              ■ 中断
            </button>
          )}
        </div>
      </div>

      <MessageList />

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={send}
        onInterrupt={sendInterrupt}
        disabled={status === "streaming" || !hasKey || !hasContext}
        reason={reason}
        placeholder={
          !hasContext
            ? "先在左栏选一个项目,或点「+ 新建」和业务经理聊聊"
            : !hasKey
              ? "请先在「设置」配置 API Key"
              : intakeActive
                ? "说说你想做什么 —— 业务经理会和你对齐,谈拢后由他立项"
                : "说点什么 · Enter 发送 · Shift+Enter 换行"
        }
      />
    </section>
  );
}
