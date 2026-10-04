/**
 * 项目对话面板(旧 `ChatSurface`)
 *
 * ── 相对旧版改了什么 ────────────────────────────────────────────
 *
 *  1. **没有 kernel 了**:旧版头部有「内核卡住了 → ↻ 重置 Kernel」,打的是
 *     `POST /api/kernel/reset` —— 新契约里**没有这条路径**(平台没有 kernel 会话)。
 *     那个按钮已删除;头部改为显示**当前项目**。
 *  2. **`/plan` 快捷指令删除**:计划概念已删(换成项目经理拆 works),再留一个
 *     `/plan` 前缀就是让用户去发一个不存在的命令。
 *  3. **发消息要选项目**:`ClientCommand.send` 需要 `projectId`。没选项目时输入区
 *     禁用并说明,而不是把命令发进 void。
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
  const projects = useChatStore((s) => s.projects);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const sendInterrupt = useChatStore((s) => s.sendInterrupt);
  const settings = useSettingsStore((s) => s.settings);
  const hasKey = !!activeProviderOf(settings)?.hasApiKey;

  const project = projects.find((p) => p.id === projectId);

  function send() {
    const text = input.trim();
    if (!text || status === "streaming" || !hasKey || !projectId) return;
    sendMessage(text);
    setInput("");
  }

  const reason: "streaming" | "noProject" | "noKey" | undefined =
    status === "streaming" ? "streaming" : !projectId ? "noProject" : !hasKey ? "noKey" : undefined;

  return (
    <section className="sansheng-card overflow-hidden flex flex-col" style={{ minHeight: 0 }}>
      <div
        className="px-4 py-2 flex items-center justify-between flex-none"
        style={{ borderBottom: "1px solid var(--ink-3)" }}
      >
        <div className="flex items-center gap-2 min-w-0">
          <span style={{ fontSize: 13, color: "var(--bone)" }}>
            {project ? project.name : "未选项目"}
          </span>
          {project && <Pill tone={projectStatusTone(project.status)}>{projectStatusLabel(project.status)}</Pill>}
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
              title="中断本项目正在跑的这一轮(等价于 Esc)"
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
        disabled={status === "streaming" || !hasKey || !projectId}
        reason={reason}
        placeholder={
          !projectId
            ? "先在左栏选一个项目"
            : !hasKey
              ? "请先在「设置」配置 API Key"
              : "说点什么 · Enter 发送 · Shift+Enter 换行"
        }
      />
    </section>
  );
}
