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
 *  5. **「推演中」不再等于「输入框禁用」(bug A,2026-10-05)**:传输级的
 *     `ChatState.status` 是「有没有人在跑」——四个角色在同一个项目里背靠背地跑时
 *     (真机 01:11–01:29:pm → bm → pm → wk → wk → wk → qa → bm),内部角色的回合
 *     把它一直置成 `streaming`,而它们的发言在对话页**看不见**(A3 滤掉了),
 *     于是用户看到的是一个「推演中」且**永远发不出话**的输入框。
 *     现在运行态按**通道**派生(`lib/data.ts` 的 `channelActivityOf` /
 *     `surfaceStatusOf`):只有**甲方通道**(你发起的那一轮 / 播报)才禁用输入框;
 *     内部在跑只显示「内部推进中」+ 保留中断按钮。
 *  6. **W2-④(2026-10-06):判据的成分跟着 `channelOf` 变了,组件本身没换**。
 *     「甲方通道」不再是「面向甲方的角色」,而是「由用户触发在页面上展示的那条
 *     通道」——输入框禁用与屏幕上显示的东西因此仍然是**同一个判据**
 *     (`channelOf`),这正是 bug A 那次修好的一半,不许在这里另立一份。
 */
import { useEffect, useMemo, useState } from "react";
import { inFlightTurns, useChatStore } from "@/stores/chat";
import { useSettingsStore, activeProviderOf } from "@/stores/settings";
import { MessageList } from "./MessageList";
import { SessionPicker } from "./SessionPicker";
import { ChatComposer } from "./ChatComposer";
import { Pill } from "@/components/ui/primitives";
import { projectStatusLabel, projectStatusTone } from "@/lib/vocab";
import {
  channelActivityOf,
  channelContextOf,
  surfaceStatusOf,
  useHarnessRoles,
  useProjectMembers,
  type SurfaceStatus,
} from "@/lib/data";

export function ChatSurface() {
  const [input, setInput] = useState("");
  const status = useChatStore((s) => s.status);
  // ⚠️ 选择器只取**引用稳定**的字段(与 MessageList 同一条):`inFlightTurns(s)`
  // 每次调用都返回新数组,直接当 selector 会让 useSyncExternalStore 每渲染都
  // 读到「新快照」。
  const inFlight = useChatStore((s) => s.inFlight);
  const inFlightOrder = useChatStore((s) => s.inFlightOrder);
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

  /** 当前上下文。`null` = 接待会话(与 `Turn.projectId` 逐字同义,不是通配)。 */
  const contextKey = intakeActive ? null : projectId;
  const live = useMemo(
    () => inFlightTurns({ inFlight, inFlightOrder }),
    [inFlight, inFlightOrder],
  );

  // 「谁面向甲方」的两跳输入,与 `MessageList` **同两个来源**(成员表 + 角色能力面)
  // —— 判据是同一条 `channelOf`,不是这里另立一份。代价是一次重复的成员表请求
  // (两个组件各读一次 `/api/projects/:id/members`);`/api/harness` 有模块级缓存。
  //
  // ⚠️ **W2-④ 起它们的地位降级了**:`channelOf` 的主判据换成了
  // `Turn.origin`(这一轮为什么存在 / 这个封套是谁发的),
  // 角色两跳只在 `origin === {source:"unknown"}`(REST 回填出来的历史轮)时
  // 才被读到。**这里仍要传 `ctx`** —— 否则刷新一次,整段历史按 fail-closed
  // 全被滤掉,输入框的判据会与屏幕上的内容对不上(见 `lib/data.ts` 的说明)。
  const members = useProjectMembers(projectId);
  const harness = useHarnessRoles();
  const ctx = useMemo(
    () =>
      channelContextOf({
        members: members.data,
        roles: harness.roles,
        ready: harness.ready,
        intake: intakeActive,
      }),
    [members.data, harness.roles, harness.ready, intakeActive],
  );
  // ⚠️ **两个维度都要给**(migration 024):`contextKey` 是「哪个项目」,
  // `sessionId` 是「这个项目里的哪条线」。只给前一个 ⇒ 一个项目下面所有线的
  // 消息混进同一个面板。
  const sessionId = useChatStore((s) => s.sessionId);
  // 服务端那份「此刻有回合在跑」—— 本地 WS 状态在刷新/切换之后会归零,
  // 那一份是**唯一**还能说出「它还在跑」的东西(见 `surfaceStatusOf` 的第三个参数)。
  const remoteRunning = useChatStore((s) => s.remoteRunning);
  const contextNotice = useChatStore((s) => s.contextNotice);
  const activity = useMemo(
    () => channelActivityOf(live, ctx, contextKey, sessionId),
    [live, ctx, contextKey, sessionId],
  );
  const surface = surfaceStatusOf(status, activity, remoteRunning);
  /**
   * **输入框唯一由「有人在跑」推出的禁用理由**:甲方通道在跑 —— 甲方自己那句
   * (乐观上屏那条不在 `inFlight` 里)、`tell_client` 的播报、或**用户触发**的
   * 那一轮正文。内部角色在跑**不**进这个判据 —— 那正是 bug A 的现场。
   *
   * ⚠️ **W2-④ 起判据的成分跟着 `channelOf` 变了**(同一个判据,不是第二处真相):
   * 「业务经理被工件叫醒的那一轮」以前算甲方通道(它按角色 `clientFacing` 判),
   * 现在算内部 —— 因为那一轮**在屏幕上也不显示**。显示与禁用必须是同一个答案,
   * 否则会出现「页面上一条甲方消息都没有,而输入框说甲方正在说话」。
   */
  const clientBusy = activity.client.length > 0;
  /** 本上下文里有在飞的轮(内部也算)—— 中断按钮的可见性。 */
  const liveCount = activity.client.length + activity.internal.length;

  function send() {
    const text = input.trim();
    if (!text || clientBusy || !hasKey || !hasContext) return;
    sendMessage(text);
    setInput("");
  }

  const reason: "streaming" | "noContext" | "noKey" | undefined =
    clientBusy ? "streaming" : !hasContext ? "noContext" : !hasKey ? "noKey" : undefined;

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
          <SurfaceStatusIndicator status={surface} />
          {/* 中断按钮的可见性跟「有没有在飞的轮」走,不跟输入框的可用性走 ——
              否则「内部在跑」时既解除了输入框禁用、又撤掉了唯一的中断入口
              (Esc 那条路要求输入框处于禁用态,见 ChatComposer)。 */}
          {liveCount > 0 && (
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

      {/* ⚠️ **独占第二行**(2026-10-06 修)。第一版把它塞进上面那一行的中间,
          与「项目名」「运行态」抢宽度 —— 真机上 9 条线把那一行撑爆,按钮被
          卡片的 `overflow-hidden` 裁在可视区之外(点不到),而且没有 nowrap 时
          CJK 会被压成「一个字一行」(看起来像样式没加载)。 */}
      <SessionPicker />

      {/* ⚠️ **上下文刚换过时的那一句解释**(2026-10-06 真机事故的修复)。
          接待会话里立项 → 服务端把消息整体迁进新项目 → 界面切过去。
          迁移是对的,但**切换必须有解释**:否则用户经历的是「我发了句话、
          等了很久、界面变了、我的话不知道去哪了」。
          它不是一条平台记录(库里不该为界面提示多写一行),所以是前端状态。 */}
      {contextNotice !== null && (
        <div
          className="flex-none"
          style={{
            padding: "6px 16px", fontSize: 11, lineHeight: "1.6",
            color: "var(--bone-dim)",
            background: "var(--ink-1)",
            borderBottom: "1px solid var(--ink-3)",
          }}
        >
          {contextNotice}
        </div>
      )}

      <MessageList />

      <ChatComposer
        value={input}
        onChange={setInput}
        onSubmit={send}
        onInterrupt={sendInterrupt}
        disabled={clientBusy || !hasKey || !hasContext}
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

/**
 * 顶部状态指示(纯 props,导出给测试)。
 *
 * 五档里只有 `internal` 是新加的,而且它**不**禁用输入框:它是「流水线在动」的
 * 可见性,不是「你不能说话」—— 后者只由 `streaming`(业务经理正在回你)表达。
 */
export function SurfaceStatusIndicator({ status }: { status: SurfaceStatus }) {
  const label =
    status === "streaming"
      ? "推演中"
      : status === "internal"
        ? "内部推进中"
        : status === "error"
          ? "出错"
          : status === "connecting"
            ? "连接中"
            : "就绪";
  const className =
    status === "error"
      ? "sansheng-text-cinnabar"
      : status === "streaming"
        ? "sansheng-text-jade"
        : "sansheng-text-mute";
  const title =
    status === "streaming"
      ? "甲方通道在跑(你发起的那一轮,或对你说的一条播报)—— 输入框先歇一会儿"
      : status === "internal"
        ? // ⚠️ 这里**不许**只写「你可以照常跟业务经理说话」:那一句在当前服务端是**空头承诺** ——
          // `hub.ts` 的「项目忙」闩由 `serve.ts` 的 `drainOne` 在**整次级联**期间持有,
          // 发出去的 `send` 会被拒(错误 `busy` 显示在会话里)。前端能诚实的部分:输入框
          // **可用**(不再是「推演中」禁用)、内部在跑**说得出来**、被拒时**看得见**。
          "内部角色(项目经理 / 工程师 / 质检)在跑 —— 输入框保持可用;" +
          "服务端在本项目这一轮排空结束前可能拒收(那条错误会显示在会话里)"
        : undefined;
  return (
    <span className={`${className} flex items-center gap-1`} title={title}>
      ● {label}
      <ElapsedSince streaming={status === "streaming" || status === "internal"} />
    </span>
  );
}

/**
 * 「已经跑了多少秒」。
 *
 * ⚠️ **为什么需要它**(2026-10-06 真机事故):业务经理有一轮跑了 **3 分 50 秒**
 * —— 那 3 分 50 秒里屏幕上只有用户自己的乐观上屏气泡,「推演中」四个字不动的。
 * 用户据此判断「被中断了、没人回应」。
 *
 * 而那 3 分 50 秒里系统**确实在干活**(开项目、拆解、读旧项目)。
 * ⇒ 一个**会走的秒数**是最便宜的证伪:它把「死了」与「在忙」分开。
 *
 * ⚠️ **它只是秒数,不是承诺**:不代表还剩多久。超过 60 秒换算成分钟 ——
 * 「已经 3 分 20 秒」比「已经 200 秒」可读得多。
 */
function ElapsedSince({ streaming }: { streaming: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  const [since, setSince] = useState<number | null>(null);

  // 只在跑的时候计时;一停下来就把基准丢掉(下一次流式重新开始算)
  useEffect(() => {
    if (!streaming) {
      setSince(null);
      return;
    }
    setSince(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [streaming]);

  if (since === null) return null;
  const sec = Math.max(0, Math.round((now - since) / 1000));
  const text = sec < 60 ? `${sec} 秒` : `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
  return (
    <span className="sansheng-text-mute" style={{ fontSize: 10 }} title="这一轮已经跑了多久">
      {text}
    </span>
  );
}
