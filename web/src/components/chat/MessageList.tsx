/**
 * 对话消息流(项目的一条连续对话)
 *
 * 旧版这里还有两种块:`plan`(计划卡)与 `delivery`(交付物卡)。计划概念在新
 * 架构里已删除(换成 works / 工件),`DeliveryBlock` 只服务旧的 `plan_done`,
 * 两者随契约一起删掉了 —— 现在只剩思考 / 正文 / 工具三类。
 *
 * ── 本批次(设计 1 §2.12 的 A3):对话页 = **甲方 ↔ 业务经理** ────────
 *
 * 1. **渲染进行中的轮表,不再渲染单槽**。A2 把 `currentTurn` 换成了按 `messageId`
 *    的轮表,但渲染层当时仍只读兼容指针 ⇒ **屏幕上只看得见最近写入的那一轮**
 *    (业务经理「先说话 → 播报 → 再说话」时前半段看不见)。这里改成
 *    `inFlightTurns(state).map(...)`,并用 `contentSignalOf(turns, streaming)`
 *    这个**列表**信号驱动滚动 —— 只算一轮的话,第二轮的 delta 不会触发跟随。
 * 2. **通道分离**:只把「由用户触发在页面上展示的那条通道」渲染成对话;其余回合
 *    被滤掉并**如实报出条数**(看不见 ≠ 不存在,见 §2.10.4)。判据是
 *    `lib/data.ts` 的 `channelOf` / `partitionTurns`(纯函数,有单测)。
 *    ⚠️ `agentId === null` **不等于**甲方 —— 它有两个作者(kind `user` / kind
 *    `system`),所以系统通知走一条**独立的提示带**,不冒充任何人的气泡。
 *
 * ── W2-④(2026-10-06):判据换成「为什么有这一轮」+ **块级过滤** ─────
 *
 * ① **通道判据不再是角色的 `clientFacing`**(那是「谁在说话」,答不了「这一轮
 *    为什么存在」)。新判据三支:甲方消息 / `source: "broadcast"`(播报,无条件)/
 *    `trigger.kind === "user"` 的回合正文 ⇒ **业务经理被工件叫醒的那一轮正文也
 *    不上屏**;它若真对甲方说了话,那话在同轮的**播报**里,那条照常显示。
 * ② **块级过滤**:判成 client 之后,一轮的 `blocks` 里**同时装着** thinking +
 *    工具卡 + 正文 —— 整轮一起进时间线,于是业务经理那个**用户触发**回合的三张
 *    工具卡与 7594 字思考条就摆在甲方的屏上(用户贴出的那串 ⚙ 的直接原因)。
 *    现在 `thinking` / `tool` 折进一行「内部过程 N 步」(`layerBlocks` +
 *    `InternalProcessDisclosure`),**可展开、不是删**(§2.10.4 的纪律)。
 *
 * ── 本批次(设计 1 §2.12 的 A4):`[未播报]` 行首分流 ────────────────
 *
 * 业务经理**决定不播**时,正文里必须留一行工作记录 `[未播报] …`
 * (`harness/system_prompts/business_manager.protocol.md:65`,硬要求;格式示例在
 * `business_manager.core.md:131`)。它随正文落成**同一条** `assistant` 消息
 * (`host/serve.ts` 的落库),而业务经理是 `clientFacing` ⇒ 通道分离之后它会
 * **整段进甲方气泡** —— 一行给下一个读会话的人(和事后追问「当时为什么没告诉我」
 * 的甲方)看的工作记录,被当成播报渲染了出来。
 *
 * 所以把它**按行首**切出来,渲染成独立的「工作记录」块:
 *   - **不滤掉**:§2.10.4 的原话是「这行甲方也看得到」,删了它「判断过」与
 *     「漏了」在记录里就长得一模一样(§2.9 末的同一条纪律);
 *   - **不与播报混在一个气泡里**:独立一块 + 左侧色条 + 小字(`.ss-worklog`)。
 *
 * 判据是 `splitWorkLog`(纯函数,导出给测试):**行首** `[未播报]`,不是包含 ——
 * 正文中段引述 `"[未播报]"` 不得分流(设计 ④ 明确要这条负样本)。
 *
 * ── 旧版留下的两件事(未改)────────────────────────────────────
 *
 * 1. **正文按 markdown 渲染**(此前是裸 `{text}`,业务经理的 `**加粗**` / 表格 /
 *    代码块在屏幕上是字面量)。解析在 `@/lib/markdown`,安全边界也在那里。
 *    用户自己键入的那条**仍按字面渲染** —— 把人打的字重新排版成标题/表格,
 *    是替他改写输入,不是他要的。
 *
 * 2. **滚动语义手写**(不用 react-virtuoso:实测 +193.3 kB raw / +61.3 kB gzip,
 *    换来的虚拟化在 14 条消息的会话里是过早优化)。三条行为与判据在
 *    `@/lib/scroll`,这里只做 DOM 侧的接线:
 *      · 贴底 → 新内容跟随(节流 80ms,避免流式高频更新把主线程压住)
 *      · 用户上滚 → 关闭跟随 + 显示「回到底部」;自己滚回底部 → 恢复跟随
 *      · 滚到顶加载历史 → **未做**(后端无分页/游标,见 lib/scroll.ts 文件头)
 */
import { Fragment, memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { inFlightTurns, useChatStore, type Block, type Turn } from "@/stores/chat";
import {
  channelContextOf,
  partitionTurns,
  useHarnessRoles,
  useProjectMembers,
  type ConversationPartition,
} from "@/lib/data";
import {
  INITIAL_FOLLOW,
  observeFollow,
  scrollBehaviorFor,
  shouldShowJumpButton,
  throttleDelay,
  type FollowObservation,
  type FollowState,
  type ScrollMetrics,
} from "@/lib/scroll";
import { Markdown } from "./Markdown";
import { ThinkingBlock } from "./ThinkingBlock";
import { ToolCallCard } from "./ToolCallCard";

function metricsOf(el: HTMLElement): ScrollMetrics {
  return { scrollTop: el.scrollTop, clientHeight: el.clientHeight, scrollHeight: el.scrollHeight };
}

/**
 * 流式正文的「内容变了」信号:两段列表的轮数 + 各块文本长度(工具块算 1)。
 *
 * ⚠️ 必须吃**列表**。旧版只算 `currentTurn` 一块,于是「第二轮在流式」这件事
 * 对滚动不可见 —— 用户上滚之后第二轮不会把他拉回底部,而屏幕上确实在打字。
 *
 * 导出是给测试用的(`tests/web/channel-filter.test.ts` 钉住「第二轮的 delta 也
 * 会改变信号」),与 `TurnView` 的导出同一个理由。
 */
export function contentSignalOf(turns: readonly Turn[], streaming: readonly Turn[]): string {
  let textLength = 0;
  for (const t of [...turns, ...streaming]) {
    for (const b of t.blocks) textLength += b.kind === "tool" ? 1 : b.text.length;
  }
  return `${turns.length}:${streaming.length}:${textLength}`;
}

/**
 * 一轮的块按**「甲方该看到什么」**分成三摞(W2-④ 的块级过滤)。
 *
 * ── 为什么要在**块**这一层再筛一次 ──────────────────────────────
 *
 * 通道判据的粒度是**轮**(= 一条 `messageId`),而一轮的 `blocks` 里**同时装着**
 * `thinking` + 工具卡 + 正文 —— 判成 `client` 之后**整轮所有块**一起进时间线。
 * 取证(用户真机贴出的那串 ⚙ `meeting_read → meeting_respond → ask_client → …`
 * 全部是业务经理自己调的工具,而那一轮是**用户触发**的 ⇒ 它进甲方通道)⇒
 * 三张工具卡 + 一个 7594 字的思考条就摆在甲方的屏上,**点一下就是它完整的内部推理**。
 *
 * ── 判据 ──────────────────────────────────────────────────────
 *
 *   - `text` —— **留下**(它就是「对甲方说的话」,由 `splitWorkLog` 再分一次流);
 *   - `thinking` / `tool` —— **折进一行可展开的「内部过程 N 步」**。
 *
 * ⚠️ **不是删**(设计 1 §2.10.4 的纪律:看不到 = 平台替甲方删证据)。所以这里
 * 只是把块**分层**,并没有丢掉任何一块 —— 折叠行展开后它们**原样渲染**
 * (工具卡还是 `ToolCallCard`,思考块还是 `ThinkingBlock`,连各自的折叠都保留)。
 *
 * ── 为什么只有「一摞」internal(而不是按连续段切)────────────────
 *
 * 用户要的形状是「**折成一行**可展开的『内部过程 N 步』」。按段切会在
 * `[text, tool, text, tool, text]` 这种真实形状里产生三条折叠行,屏幕上反而更吵。
 * 折叠行落在**第一个内部块原来所在的位置**:`[thinking, tool, tool, text]` ⇒
 * 「内部过程 3 步」在正文上方(与真实回合的形状一致 —— 先想、再做、最后说)。
 */
export interface BlockLayers {
  /** 折叠行**之前**渲染的块(按构造:全是 `text`) */
  readonly before: readonly Block[];
  /** 折进「内部过程 N 步」那一行的块(`thinking` / `tool`),**原序**,一块不丢 */
  readonly internal: readonly Block[];
  /** 折叠行**之后**渲染的块(按构造:全是 `text`) */
  readonly after: readonly Block[];
}

/** 把一轮的块分成三摞(纯函数,导出给测试)。 */
export function layerBlocks(blocks: readonly Block[]): BlockLayers {
  const firstInternal = blocks.findIndex((b) => b.kind !== "text");
  if (firstInternal === -1) return { before: blocks, internal: [], after: [] };
  return {
    before: blocks.slice(0, firstInternal),
    internal: blocks.filter((b) => b.kind !== "text"),
    after: blocks.slice(firstInternal + 1).filter((b) => b.kind === "text"),
  };
}

/**
 * 「内部过程」那一行的**折叠状态持有者**(与 `ThinkingBlock` 同款:
 * 状态壳 + 纯展示面分开,理由见 `ThinkingBlock.tsx` 的注释)。
 *
 * 默认**折叠** —— 常量导出,好让「默认值是折叠」在测试里可断言,而不是藏在
 * `useState(false)` 的字面量里。
 */
export const INTERNAL_PROCESS_DEFAULT_OPEN = false;

export function InternalProcessBlock({
  blocks,
  streaming,
}: {
  blocks: readonly Block[];
  streaming?: boolean;
}) {
  // 组件内状态,每轮一份(**不进 store** —— 它是一块正文的展示状态,进了 store
  // 就变成第二处真相,还要为它编「刷新 / 换项目 / 换轮时怎么清」的规则)。
  const [open, setOpen] = useState(INTERNAL_PROCESS_DEFAULT_OPEN);
  return (
    <InternalProcessDisclosure
      blocks={blocks}
      open={open}
      onToggle={() => setOpen((v) => !v)}
      streaming={streaming}
    />
  );
}

/**
 * 「内部过程 N 步」的**纯展示面**(导出给测试)。
 *
 * ── 折叠态:只有元信息,没有内容 ────────────────────────────────
 *
 * 与 `ThinkingDisclosure` 同一条纪律:折叠态**不进渲染产物**。所以这里只报
 * **步数与构成**(`内部过程 3 步 · 思考 1 段 · 工具 2 次`),**不报工具名、不报
 * 一个字的推理** —— 工具名本身就是被折叠掉的那部分证据(`meeting_read` /
 * `tell_client` 这些名字在说什么,用户已经很清楚了)。
 *
 * ⚠️ 但 `思考 N 段` 这半句是**刻意留的**:它让「折叠」与「这一轮内部压根没有推理」
 * 在屏幕上区分得开(§2.10.4 的同一条纪律:判断过 ≠ 漏了)。
 *
 * ── 展开态:原样交回每一个块 ────────────────────────────────────
 *
 * `ToolCallCard` / `ThinkingBlock` 都是既有组件 —— 展开**不重新实现**它们,
 * 也就不可能在这里把证据改写或丢掉。`ThinkingBlock` 自己仍默认折叠:§2.10.4 的
 * 裁决是「思考留,但默认折叠」,展开「内部过程」不该等于把 7594 字推理直接倒到
 * 屏幕上(它一条一块、各有各的展开)。
 */
export function InternalProcessDisclosure({
  blocks,
  open,
  onToggle,
  streaming,
}: {
  blocks: readonly Block[];
  open: boolean;
  onToggle: () => void;
  streaming?: boolean;
}) {
  const thinkingCount = blocks.filter((b) => b.kind === "thinking").length;
  const toolCount = blocks.filter((b) => b.kind === "tool").length;
  return (
    <div
      className="rounded-md self-start"
      data-channel="internal-process"
      style={{
        background: "rgba(94, 139, 126, 0.06)",
        border: "1px solid rgba(94, 139, 126, 0.25)",
        maxWidth: "85%",
      }}
    >
      <button
        onClick={onToggle}
        aria-expanded={open}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left"
        style={{ color: "var(--bone-dim)", fontSize: 12 }}
        title={
          open
            ? "收起内部过程(思考与工具调用)"
            : "展开内部过程:这一轮里模型想了什么、调了哪些工具(内部过程,不是对你说的话)"
        }
      >
        <span
          style={{
            color: "var(--jade)",
            display: "inline-block",
            transition: "transform var(--duration-160) var(--ease-out)",
            transform: open ? "rotate(90deg)" : "none",
          }}
        >
          ›
        </span>
        <span className="font-mono" style={{ fontSize: 11 }}>
          内部过程 {blocks.length} 步
        </span>
        {!open && (
          // 折叠态只报**构成**,不报内容(工具名与推理正文都不进 DOM)。
          <span className="sansheng-text-mute ml-2" style={{ fontSize: 11 }}>
            {thinkingCount > 0 ? `思考 ${thinkingCount} 段 · ` : ""}工具 {toolCount} 次
          </span>
        )}
      </button>
      {open && (
        <div
          className="px-3 py-2 flex flex-col gap-2"
          style={{ borderTop: "1px solid rgba(94, 139, 126, 0.2)" }}
        >
          {blocks.map((b, i) =>
            b.kind === "thinking" ? (
              <ThinkingBlock
                key={i}
                text={b.text}
                streaming={streaming && i === blocks.length - 1}
              />
            ) : b.kind === "tool" ? (
              <ToolCallCard key={i} block={b} />
            ) : null,
          )}
        </div>
      )}
    </div>
  );
}

/**
 * 正文切出来的两段:「对甲方说的话」与「工作记录」。
 *
 * 与 `lib/data.ts` 的 `TurnChannel` 分开:**通道**判的是「这一轮是谁说的」
 * (甲方 / 面向甲方的角色 / 平台通知),**这个**判的是「这一块正文里哪几行不是
 * 给甲方的话」—— 两者作用在不同粒度上,合并成一个类型会让「一轮里既有播报又有
 * 工作记录」这件事没法表达。
 */
export interface TextSegment {
  readonly kind: "speech" | "work_log";
  readonly text: string;
}

/**
 * 工作记录的**行首**判据。
 *
 *   - `^` 是行首,不是包含:正文中段引述 `"[未播报]"`(例如「甲方问:为什么有
 *     `[未播报]` 这行?」)不分流 —— 那是**对甲方说的话**。
 *   - `[ \t]*` 允许行首的水平空白:提示词示例写在代码块里,缩进仍属行首;
 *     破折号开头的列表项(`- [未播报] …`)因此**不**匹配 —— 那已经是一条列表
 *     正文,不是提示词要求的那一行。
 *   - 不用 `m` 标志:输入是先 split 出来的**单行**,`^` 天然就是这一行的行首。
 */
const WORK_LOG_LINE = /^[ \t]*\[未播报\]/;

/**
 * 把一段正文按「工作记录」切开(纯函数,导出给测试)。
 *
 * ── 一行还是一段 ────────────────────────────────────────────────
 *
 * 提示词要求工作记录「**一行,最多两句**」,但它自己给的示例是**硬折行的三行**
 * (`business_manager.core.md:131` —— 第一行结尾是「钱」,没有句末标点)。所以这里
 * 以**空行为界**:匹配行 + 其后的连续非空行属于同一条工作记录;空行之后回到播报。
 *
 * **为什么敢把续行也折进去**(而不是只折匹配的那一行):折错的方向只是「把一句
 * 播报挪进工作记录块」,而那块**照样在屏幕上**(不是折叠、不丢字符)⇒ 代价是
 * 分组,不是证据消失。反过来「只折一行 + 工作记录被硬折行」会让半句工作记录
 * 留在甲方气泡里 —— 那才是这一批要消灭的混合。
 *
 * 只用空白行组成的段**不产出**气泡(它们只是分隔符)。
 */
export function splitWorkLog(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  let kind: TextSegment["kind"] = "speech";
  let buf: string[] = [];
  const flush = () => {
    if (buf.length === 0) return;
    // 段的**两头不留空行**:空行是分隔符,不是内容。留在段里只会在气泡开头
    // 多一个空行(markdown 忽略它,但字面量渲染看得到),也会让 `splitWorkLog`
    // 的输出对同一个输入有两种形状。
    const joined = buf.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
    buf = [];
    if (joined.trim() === "") return; // 纯空白段不成块
    segments.push({ kind, text: joined });
  };
  for (const line of text.split("\n")) {
    if (kind === "speech" && WORK_LOG_LINE.test(line)) {
      flush();
      kind = "work_log";
      buf.push(line);
      continue;
    }
    if (kind === "work_log" && line.trim() === "") {
      // 空行 = 这条工作记录结束。**不把空行带进下一段**:它只是分隔符,
      // 带进去会在播报气泡的开头留一个空行。
      flush();
      kind = "speech";
      continue;
    }
    buf.push(line);
  }
  flush();
  return segments;
}

export function MessageList() {
  const turns = useChatStore((s) => s.turns);
  // ⚠️ 选择器只取**引用稳定**的字段:`inFlightTurns(s)` 每次调用都返回新数组,
  // 直接当 selector 会让 useSyncExternalStore 每次渲染都读到「新快照」。
  const inFlight = useChatStore((s) => s.inFlight);
  const inFlightOrder = useChatStore((s) => s.inFlightOrder);
  const error = useChatStore((s) => s.error);
  const status = useChatStore((s) => s.status);
  // 切换上下文(项目 / 接待会话)= 换了一整条对话:跟随状态归零并直接跳到底。
  const projectId = useChatStore((s) => s.projectId);
  const intakeActive = useChatStore((s) => s.intakeActive);

  /** 进行中的轮,按开始顺序 —— A2 交给渲染层的那一个接口。 */
  const streaming = useMemo(
    () => inFlightTurns({ inFlight, inFlightOrder }),
    [inFlight, inFlightOrder],
  );

  // 「谁面向甲方」的两跳输入:成员表(agentId → role)+ 角色能力面(role → clientFacing)。
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

  const history = useMemo(() => partitionTurns(turns, ctx), [turns, ctx]);
  const live = useMemo(() => partitionTurns(streaming, ctx), [streaming, ctx]);
  const hidden = history.hidden + live.hidden;
  const hiddenNote =
    hidden === 0
      ? null
      : !harness.ready
        ? `另有 ${hidden} 条消息暂时无法归类 —— 角色能力面(GET /api/harness)还没读到` +
          (harness.error !== null ? `:${harness.error}` : "")
        : `另有 ${hidden} 条回合不在这条通道里(不是由你触发、也不是播报)—— 到「成员」页逐人查看`;

  const ref = useRef<HTMLDivElement>(null);
  /** 跟随状态用 ref 持有 —— onScroll 每帧都在读它,不该为它触发一次渲染。 */
  const followRef = useRef<FollowState>(INITIAL_FOLLOW);
  const lastScrollAtRef = useRef(0);
  const pendingScrollRef = useRef<number | null>(null);
  const [showJump, setShowJump] = useState(false);

  /** 把一次观察喂给纯函数状态机,并只把「要不要显示按钮」这一位同步到渲染。 */
  const apply = useCallback((o: FollowObservation) => {
    const next = observeFollow(followRef.current, o);
    followRef.current = next;
    setShowJump(shouldShowJumpButton(next));
  }, []);

  /** 真正的程序滚动(唯一一处调用 `scrollTo`)—— 记时间戳 + 同步 lastTop。 */
  const doScroll = useCallback((behavior: ScrollBehavior) => {
    const el = ref.current;
    if (!el) return;
    lastScrollAtRef.current = Date.now();
    el.scrollTo({ top: el.scrollHeight, behavior });
    followRef.current = { ...followRef.current, lastTop: el.scrollTop };
  }, []);

  /**
   * 节流后的程序滚动:距上次不足 80ms 就排一个**尾随**定时器(已有则不再排),
   * 这样流式高频更新下不会每帧都滚,但停下来时一定会滚到最新位置。
   */
  const scheduleScroll = useCallback(
    (behavior: ScrollBehavior) => {
      const delay = throttleDelay(lastScrollAtRef.current, Date.now());
      if (delay === 0) {
        doScroll(behavior);
        return;
      }
      if (pendingScrollRef.current !== null) return;
      pendingScrollRef.current = window.setTimeout(() => {
        pendingScrollRef.current = null;
        doScroll(behavior);
      }, delay);
    },
    [doScroll],
  );

  useEffect(
    () => () => {
      if (pendingScrollRef.current !== null) window.clearTimeout(pendingScrollRef.current);
    },
    [],
  );

  // ① 内容变化(新消息 / 流式 delta)→ 贴底才跟随。
  //    依赖用长度信号而不是 `turns` 引用:delta 只改最后一个块的**文本**,
  //    只依赖 `blocks.length` 的话流式打字期间根本没跟随;**只算一轮**的话第二轮
  //    不跟随(本批次修掉的那一半)。
  const contentSignal = useMemo(() => contentSignalOf(turns, streaming), [turns, streaming]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "content", metrics: metricsOf(el) });
    if (!followRef.current.following) return;
    scheduleScroll(scrollBehaviorFor("content"));
  }, [contentSignal, apply, scheduleScroll]);

  // ② 换项目 / 进接待会话 → 归零并跳到底(不继承上一条对话的滚动位置)。
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "reset", metrics: metricsOf(el) });
    doScroll(scrollBehaviorFor("reset"));
  }, [projectId, intakeActive, apply, doScroll]);

  /** 用户滚回底部 → 恢复跟随;上滚 → 关闭跟随(见 lib/scroll.ts 的方向判据)。 */
  function handleScroll() {
    const el = ref.current;
    if (!el) return;
    apply({ kind: "scroll", metrics: metricsOf(el) });
  }

  function jumpToBottom() {
    apply({ kind: "pin-bottom" });
    lastScrollAtRef.current = 0; // 用户主动动作不受节流限制
    scheduleScroll(scrollBehaviorFor("pin-bottom"));
  }

  // 一条轮都没有(且没有在跑的回合)= 真的空。**注意判据是「有没有轮」而不是
  // 「有没有可见的轮」**:全是内部角色的发言时不能显示空态 —— 那等于告诉甲方
  // 「什么都没发生」,而实际上团队刚说了 20 句(下面的条数提示才是对的回答)。
  if (turns.length === 0 && streaming.length === 0) return <Empty />;

  return (
    <div className="flex-1 relative flex flex-col" style={{ minHeight: 0 }}>
      <div
        ref={ref}
        onScroll={handleScroll}
        className="flex-1 overflow-y-auto px-6 py-5"
        style={{ minHeight: 0 }}
      >
        <div className="max-w-3xl mx-auto flex flex-col gap-6">
          <ConversationStream
            history={history.timeline}
            streaming={live.timeline}
            hiddenNote={hiddenNote}
          />
          {error && status === "error" && (
            <div
              className="rounded-md px-3 py-2"
              style={{
                background: "rgba(229, 72, 77, 0.1)",
                border: "1px solid rgba(229, 72, 77, 0.4)",
                color: "var(--cinnabar)",
                fontSize: 12,
              }}
            >
              <div className="font-mono">{error.code}</div>
              <div className="mt-1">{error.message}</div>
            </div>
          )}
        </div>
      </div>
      {showJump && (
        <button
          className="sansheng-button absolute"
          style={{
            bottom: 12,
            left: "50%",
            transform: "translateX(-50%)",
            background: "var(--ink-2)",
            boxShadow: "var(--shadow-ink)",
          }}
          onClick={jumpToBottom}
          title="有更新的内容(用户上滚后不自动跟随)"
        >
          ↓ 回到底部
        </button>
      )}
    </div>
  );
}

/**
 * 已分好通道的一屏(纯 props)。
 *
 * 导出是给测试用的 —— 与 `TurnView` 同一个理由:`MessageList` 从 zustand 取数据,
 * 而 SSR 下 store 读的是 server snapshot(`setState` 驱动不了,见
 * `tests/web/message-list.test.ts` 文件头)。「哪一类轮进哪条通道」这个判据在
 * `lib/data.ts` 的纯函数里,这里只负责把它渲染对。
 */
export function ConversationStream({
  history,
  streaming,
  hiddenNote,
}: {
  history: ConversationPartition["timeline"];
  streaming: ConversationPartition["timeline"];
  /** 被滤掉的条数说明;`null` = 一条都没被滤掉 */
  hiddenNote: string | null;
}) {
  return (
    <>
      {history.map(({ turn, channel }) =>
        channel === "system" ? (
          <SystemNotice key={turn.id} turn={turn} />
        ) : (
          <TurnView key={turn.id} turn={turn} />
        ),
      )}
      {streaming.map(({ turn, channel }) =>
        channel === "system" ? (
          <SystemNotice key={turn.id} turn={turn} />
        ) : (
          <TurnView key={turn.id} turn={turn} streaming />
        ),
      )}
      {hiddenNote !== null && <HiddenNotice note={hiddenNote} />}
    </>
  );
}

function Empty() {
  return (
    <div
      className="flex-1 overflow-y-auto flex items-center justify-center px-6"
      style={{
        background:
          "radial-gradient(600px 400px at 50% 50%, rgba(94,139,126,0.05), transparent 60%)",
      }}
    >
      {/* 原文案是三段:人格名 / 「你的数字雇员 · token 是工资 · 思考 / 行动 / 反思 都在这里」
          / 一块「先到设置配 API Key;配好后回来发条消息试试」的方框。
          slogan 是产品介绍文案(README 里有),不是界面文案 —— 只留人格名 + 可执行的一步。 */}
      <div className="flex flex-col items-center gap-3 text-center">
        <svg width="44" height="44" viewBox="0 0 64 64">
          <g stroke="#5E8B7E" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M16 22 L32 14 L48 22 L48 42 L32 50 L16 42 Z" />
            <path d="M32 14 L32 50" />
            <path d="M16 22 L48 42" />
            <path d="M48 22 L16 42" />
          </g>
          <circle cx="32" cy="32" r="3.5" fill="#5E8B7E" />
        </svg>
        <div className="font-serif text-xl" style={{ color: "var(--bone)", letterSpacing: ".08em" }}>
          三生
        </div>
        <p className="sansheng-text-mute" style={{ fontSize: 12 }}>
          先到「设置」配一个 Provider 的 API Key,回来发条消息试试。
        </p>
      </div>
    </div>
  );
}

/**
 * **平台通知**的独立提示带(设计 1 §2.10)。
 *
 * 为什么要单独一条带,而不是当成一条普通轮渲染:
 *   - 它的 `agent_id` 也是 `NULL`,与甲方的消息**同一个分组键** —— 若按
 *     `agentId` 判,它会**冒充甲方说的话**(A1 在真机上实测到的那个坑);
 *   - 它也不是任何角色的发言(作者是平台:排空器异常停下时的
 *     `announceDrain`,`serve.ts`)。
 * 所以它既不进甲方气泡,也不进业务经理气泡,而是一条居中、等宽、虚线框的提示。
 * **不删它** —— 它是「排空器异常停止」在界面上唯一的现场,删了之后「判断过」
 * 与「漏了」看起来一模一样(§2.9 末的同一条纪律)。
 */
function SystemNotice({ turn }: { turn: Turn }) {
  const text = turn.blocks
    .map((b) => (b.kind === "tool" ? "" : b.text))
    .join("\n")
    .trim();
  return (
    <div className="flex justify-center" data-channel="system">
      <div
        className="rounded-md px-3 py-1.5 ss-note"
        style={{ border: "1px dashed var(--ink-3)", maxWidth: "85%", textAlign: "center" }}
        title="平台通知:不是甲方说的,也不是任何角色的发言"
      >
        <span className="font-mono" style={{ fontSize: 10, letterSpacing: ".08em" }}>
          系统
        </span>
        {text !== "" && (
          <div style={{ whiteSpace: "pre-wrap", color: "var(--bone)", fontSize: 12 }}>{text}</div>
        )}
      </div>
    </div>
  );
}

/**
 * 「有多少条没显示」。
 *
 * 通道分离把不进甲方通道的回合挡在对话页之外 —— 但**不能静默**:看不到就等于平台
 * 替甲方删了证据(§2.10.4)。所以滤掉多少条必须写在屏幕上,并指向「成员」页
 * 那份逐人清单。
 */
function HiddenNotice({ note }: { note: string }) {
  return (
    <div className="flex justify-center" data-channel="hidden">
      <div className="ss-note" style={{ fontSize: 11, textAlign: "center" }}>
        {note}
      </div>
    </div>
  );
}

/**
 * `memo` 保留的原因:streaming 时每个 delta 都会 set 一遍 turns/inFlight,
 * 没有 memo 的话**整屏对话重渲染**(滚动位置与焦点都会跳)。turn 对象引用未变的
 * 轮次因此被跳过 —— store 只替换正在流式的那一轮。
 *
 * 导出是给测试用的:`tests/web/message-list.test.ts` 直接渲染它(纯 props、
 * 不碰 store)—— 「哪一类块走 markdown、流式时怎么处置表格」这条判据在这里,
 * 而 store 在 SSR 下读的是 zustand 的 server snapshot(store 创建时的初值),
 * 驱动不了。滚动那部分另走纯函数测试(见 lib/scroll.ts)。
 */
export const TurnView = memo(function TurnView({
  turn,
  streaming = false,
}: {
  turn: Turn;
  streaming?: boolean;
}) {
  const isUser = turn.role === "user";
  const usage = turn.usage;
  const showUsage = !!usage && usage.input + usage.output > 0;
  /**
   * **块级过滤**(W2-④):思考块与工具卡折进一行「内部过程 N 步」,正文留下。
   *
   * 这一层**不判通道** —— 它判的是「一轮里哪几块是给甲方看的话」。判通道是
   * `lib/data.ts` 的 `channelOf`,而它作用在**轮**上:能走到 `TurnView` 的轮
   * 只有 `client` / `system` 两种(`internal` 的轮被 `partitionTurns` 滤掉,
   * `system` 走 `SystemNotice` 不经过这里)⇒ 这里折的就是**甲方通道那一轮**的
   * 内部过程。**内部轮根本不必折 —— 它们压根不上屏。**
   */
  const layers = useMemo(() => layerBlocks(turn.blocks), [turn.blocks]);
  /** 渲染序列:正文摞 → (有内部块时)折叠行 → 正文摞。折叠行落在第一个内部块原位。 */
  const items: Array<{ kind: "text"; text: string } | { kind: "internal" }> = [
    ...layers.before.map((b) => ({ kind: "text" as const, text: b.kind === "text" ? b.text : "" })),
    ...(layers.internal.length > 0 ? [{ kind: "internal" as const }] : []),
    ...layers.after.map((b) => ({ kind: "text" as const, text: b.kind === "text" ? b.text : "" })),
  ];
  return (
    <div className={`flex flex-col gap-2 ${isUser ? "items-end" : "items-start"}`}>
      {/* 说话人 + usage 合并成一行:用户轮不标说话人(气泡靠右已经说明了),
          助手轮只在有真实 token 时才显示数字。 */}
      {!isUser && (showUsage || streaming) && (
        <div
          className="w-full flex items-baseline gap-2"
          style={{ fontSize: 11, letterSpacing: ".04em" }}
        >
          <span className="font-serif sansheng-text-dim">{streaming ? "三生 · 推演中" : "三生"}</span>
          {showUsage && usage ? (
            <span className="ss-meta ml-auto">
              in {usage.input} · out {usage.output}
            </span>
          ) : null}
        </div>
      )}
      <div
        className={`flex flex-col gap-1 ${isUser ? "items-end" : "items-start"} w-full`}
      >
        {turn.blocks.length === 0 && streaming && (
          <div
            className="rounded-md animate-pulse-soft"
            style={{
              width: 80,
              height: 14,
              background: "var(--ink-2)",
              border: "1px solid var(--ink-3)",
            }}
          />
        )}
        {items.map((item, i) => {
          const isLastItem = i === items.length - 1;
          if (item.kind === "internal") {
            return (
              <InternalProcessBlock
                key={i}
                blocks={layers.internal}
                streaming={streaming && isLastItem}
              />
            );
          }
          // 这一层只剩正文(思考 / 工具卡已全部折进 `layers.internal`)——
          // **只有助手的正文**参与工作记录分流:甲方自己打的字按字面渲染
          // (`Bubble` 的 user 分支),把人打的字重新分类是替他改写输入;
          // 平台通知走 `SystemNotice`,根本不到这里。
          const segments: readonly TextSegment[] = isUser
            ? [{ kind: "speech", text: item.text }]
            : splitWorkLog(item.text);
          return (
            // Fragment 不产生 DOM 节点 ⇒ 这些块仍是那一列 flex 的直接子元素,
            // 气泡间距(`gap-1`)与分流前一致。
            <Fragment key={i}>
              {segments.map((seg, j) => {
                const isLastSegment = streaming && isLastItem && j === segments.length - 1;
                return seg.kind === "work_log" ? (
                  <WorkLogBlock key={j} text={seg.text} streaming={isLastSegment} />
                ) : (
                  <Bubble key={j} user={isUser} text={seg.text} streaming={isLastSegment} />
                );
              })}
            </Fragment>
          );
        })}
      </div>
    </div>
  );
});

/**
 * 「工作记录」块 —— 业务经理**决定不播**时留在正文里的那行 `[未播报] …`。
 *
 * ── 为什么它必须留在屏幕上(而不是滤掉)──────────────────────────
 *
 * 它是「判断过,决定不打扰你」这件事**在会话记录里唯一的现场**
 * (`business_manager.protocol.md:65` 说得很直白:少了它,「判断过」与「漏了」
 * 在记录里长得一模一样)。所以 §2.10.4 的裁决是**留,但与播报视觉分开** ——
 * 看不到就等于平台替甲方删了证据,那与「平台偷偷替他决定」是一回事。
 *
 * 呈现上刻意与甲方气泡不同:气泡是 `--ink-1` 底 + 整圈描边 + 14px 正文,这块是
 * 左侧 jade 色条 + `--ink-2` 底 + 10px 等宽标签 + 12px 小字(样式在 globals.css
 * 的 `.ss-worklog`)。**不折进 ThinkingBlock 那种可折叠壳**:它是给甲方看的,
 * 默认就该在屏幕上。
 */
function WorkLogBlock({ text, streaming }: { text: string; streaming?: boolean }) {
  return (
    <div
      className="ss-worklog"
      data-channel="work-log"
      title="工作记录:业务经理判断「这次不值得打扰你」时留下的现场(设计 1 §2.10.4)"
    >
      <span className="ss-worklog-label">工作记录 · 未播报</span>
      <span className="ss-worklog-text">
        {text}
        {streaming && (
          <span className="animate-caret" style={{ color: "var(--jade)" }}>
            ▍
          </span>
        )}
      </span>
    </div>
  );
}

function Bubble({ user, text, streaming }: { user: boolean; text: string; streaming?: boolean }) {
  return (
    <div
      className="rounded-lg px-4 py-3 max-w-[85%]"
      style={{
        background: user ? "var(--ink-2)" : "var(--ink-1)",
        border: "1px solid var(--ink-3)",
        color: "var(--bone)",
        fontSize: 14,
        lineHeight: 1.65,
        // 用户自己键入的内容按字面显示(换行就是他打的换行);
        // 模型输出交给 .ss-md 自己排版,pre-wrap 会干扰块级元素的间距。
        whiteSpace: user ? "pre-wrap" : undefined,
        wordBreak: "break-word",
      }}
    >
      {user ? text : <Markdown text={text} streaming={streaming} />}
      {streaming && <span className="animate-caret" style={{ color: "var(--jade)" }}>▍</span>}
    </div>
  );
}
