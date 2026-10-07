/**
 * 平台运行时 · 一个回合(BC6 执行层的地基)
 *
 * ── 为什么把它单独抽出来 ────────────────────────────────────────
 *
 * 「跑一个回合」在三处都要用:执行一个工作项(BC6)、对一次提问作出答复、
 * 以及将来的周期对焦。它们的形式完全一样:
 *
 *   收集待办 → 拼进消息 → 发给模型 → 等它收敛 → 收集它做了什么
 *
 * 分开写就会写成三份,而每份都会漏掉点什么 —— 通常是「留现场」那部分。
 *
 * ── 待办注入为什么拼在 user 消息里,而不是重建会话 ──────────────────
 *
 * 待办每回合都在变(有人刚问了你、会议刚开)。拼进系统提示意味着每回合重建
 * 会话 —— 那会丢掉会话历史,而历史正是「它已经查过什么」的来源(7-N:每轮
 * 重拼 transcript 导致模型原地打转)。
 *
 * 拼在 user 消息前部则不动会话历史,且模型能看到「这是系统替我列的待办,
 * 下面才是我该干的事」这个层次。
 *
 * ── 留现场(7-N 的教训)────────────────────────────────────────
 *
 *   「7-N 之前 executor 未收敛的 note 只有一句「未收敛」,**零现场**,
 *    根因是另写探针才复现出来的。**新写任何失败分支前先问:事后能不能从
 *    产物里看出当时发生了什么?** 见不到的现场等于没有现场。」
 *
 * 所以 `TurnResult` 必须带回 `toolCalls`(名字 / 参数摘要 / 是否失败)与
 * `timedOut`。一个超时的回合如果只返回空字符串,事后无从判断它卡在哪。
 *
 * ── 两个「超时」是两件事(别把它们合并)──────────────────────────
 *
 * 真机现场:一个 worker 回合**跑了 16 分钟还没完**,watcher 15 分钟窗口里
 * 它一直在用 `bash` curl 阿里云文档。而 `timeoutMs` 完全没拦住它 ——
 * 那个定时器只把 `settled` 置真,而 `settled` 只在
 * `await session.prompt(payload)` **resolve 之后**被读到。`session.prompt()`
 * 自己不会被打断,于是「回合的时长」从来没有任何上界。后果不只是烧钱:
 * 排空器下它一直占着那个项目的 busy 闩,该项目后续**所有**待办都推不动。
 *
 * 于是现在有两个上界,职责不同、都必须存在:
 *
 *   `timeoutMs`(缺省 5 分钟)**现有语义,未改** —— 它护的是
 *     「`prompt()` resolve 之后,等 `agent_settled` / `agent_end` 那段收尾等待」。
 *     `prompt()` 已经返回、而收敛事件迟迟不来时,不让这个 `while` 永不退出。
 *     它**不打断**任何东西(此时也没什么可打断的)。
 *
 *   `wallClockTimeoutMs`(缺省 10 分钟)**新墙钟上界** —— 从发出去那一刻起
 *     算真实墙钟时间,到点**调 `AgentSession.abort()` 真的把回合打断**,
 *     并把现场(跑了多久 / 打断瞬间在跑哪个工具 / abort 有没有失败)带回。
 *     这才是「一个回合最多花多久」的上界。
 *
 * 登记(`setTimeout` + 它到点时对 `session.abort()` 的调用)必须发生在
 * **第一次 `await` 之前** —— 批次 19 的教训原话:「放在 `await runTurn(...)`
 * 之后等于永远登记不上」。前端中断按钮曾在同一个缝隙里死接线过。
 *
 * ── 用量(usage)为什么必须在**事件时刻**读并深拷贝 ──────────────────
 *
 * 真机探针(T1)的实测:一次 LLM 调用的 `Usage` 是**一个对象**,它被 `message_start`
 * / N 条 `message_update` / `message_end` **共享**,并且在流的过程中被**就地改写**:
 *
 *   message_start      usage 键在,值全零
 *   message_update ×N  usage 键在,值全零(每条 partial 都带)
 *   message_end        ★ 事件时刻即终值
 *   turn_end           ★ 同一条消息的第二次投递(对象身份相同)
 *   agent_end.messages ★ 第三次投递(对象身份相同)
 *
 * 于是有三种写法都「看起来能跑通」,而只有一种是对的:
 *
 *   ① **在 `message_start` / `message_update` 上读** ⇒ 拿到 0(那一刻真的还是 0);
 *   ② **记住最后一次 partial 的 `message` 引用,回合结束后再读它的 usage**
 *      ⇒ 拿到**终值** —— 因为那个对象被改写了。它和正确实现**值上完全一样**,
 *      所以任何只断言「落库的数字对不对」的测试都**抓不到它**。
 *      T1 的探针 v1 就是这么坏掉的:它把 `{path, value}` 存成引用,打印时回合
 *      早已结束,于是 `message_start` 那一行显示 `output=61`,看起来「usage 从
 *      第一个事件起就是完整的」。**那是假的。**
 *   ③ 在 `message_end` **事件发生的那一刻读、并深拷贝** ⇒ 唯一稳的读法(本文件)。
 *
 * ⇒ 累加器里放的是**值的快照**(三个数字),不是对象引用。这条纪律的机器形式在
 * `tests/platform/turn-usage-write.test.ts`,其中有两条负样本:
 * 「事件时刻快照 ≠ 回合结束后读引用」(把差别打出来),
 * 以及「同一个对象在 `message_end` 之后又被改写时,落库的值不许跟着变」。
 *
 * ── 为什么是「每个回合一行」而不是「每次 LLM 调用一行」 ──────────────
 *
 * 一个回合可能调 N 次工具 ⇒ N+1 次 LLM 调用 ⇒ N+1 条 usage。三条投递路径
 * (`message_end` / `turn_end` / `agent_end.messages`)逐项相等 ——
 * **同时累加两条会把同一份用量算两遍**。所以只认 `message_end` 一条,
 * 在回合结束时**求和写一行**(表是回合级的,见 `migrations/018`)。
 */
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { log } from "../../shared/log.js";
import type Database from "better-sqlite3";
import {
  collectPendingWork, renderPendingWork, summarizePendingWork,
} from "./pendingWork.js";
import { renderProjectContext } from "./projectContext.js";
import { listSessionMessages } from "../storage/repo/sessions.js";
import { insertTurnUsage, type TurnUsageRow } from "../storage/repo/usage.js";

/** 一次工具调用的现场记录。 */
export interface ToolCallRecord {
  readonly name: string;
  /** 参数的可读摘要(截断) */
  readonly argsSummary: string;
  readonly isError: boolean;
  /** 结果的简短摘要(截断) */
  readonly resultSummary: string;
  readonly durationMs: number;
}

/**
 * **一次 LLM 调用**在 `message_end` 那一刻的用量快照。
 *
 * ⚠️ 它是一个**值的拷贝**,不是 SDK 那个 `Usage` 对象 —— 那个对象在整个流的
 * 过程中被就地改写(见文件头)。存引用 = 存了一个「以后还会变」的东西,
 * 而它变化的方向恰好是「从 0 变成终值」,于是错误的实现会**看起来完全正确**。
 *
 * 字段名以 `pi-ai/dist/types.d.ts` 的 `Usage` 为准:`input` / `output` /
 * `cacheRead` / `cacheWrite` / `reasoning` / `totalTokens` / `cost`。
 * **没有 `inputTokens` / `outputTokens`** —— 读名字之前先 grep 类型定义。
 *
 * 只取三个:落库的形状(`turn_usage`)就是 `input_tokens` / `output_tokens` /
 * `cache_read`;**`cost` 刻意不取**(用户已定:只显示 token 数,不显示金额)。
 */
export interface TurnUsageCall {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 这条 assistant 消息自称的模型 id;读不到为 `null` */
  readonly model: string | null;
}

/** 一个回合的用量合计(`TurnResult.usage` 与落库行同源)。 */
export interface TurnUsageTotal {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  /** 这一回合里有几条 assistant `message_end`(即几次 LLM 调用) */
  readonly calls: number;
  /**
   * 落库那一行的 id。**报告里要能指出「哪一行」** —— 没有它,一次
   * 「账目对不上」只能靠时间戳去库里猜。
   */
  readonly rowId: string;
}

export interface TurnResult {
  /** 助手说出的正文 */
  readonly text: string;
  /** 内部推理(与正文分开 —— 7-I 的现场是两者混在一起被当成回复展示) */
  readonly thinking: string;
  /** **现场**:这一回合调了哪些工具、哪些失败了 */
  readonly toolCalls: readonly ToolCallRecord[];
  /**
   * 这一回合里**新立项的项目 id**(按调用顺序)。
   *
   * 来源是工具结果的结构化 `details.data.projectId`(见 `project_open` 与
   * `sdkAdapter.ts`),**不是正则抠文本** —— 文案改一个字就会让文本解析静默失效,
   * 而这条通道本来就是判工具成败用的(见下面的 `toolCallFailed`)。
   *
   * 宿主靠它把接待会话切到新项目。空数组 = 这一回合没有立项。
   */
  readonly openedProjectIds: readonly string[];
  readonly pending: {
    readonly injected: boolean;
    readonly summary: string;
  };
  /**
   * **我在哪个项目** —— 与 `pending` 同级的现场记录。
   *
   * 没有它,「业务经理说当前没有在跑的项目」这类事故在事后只能靠翻库复原
   * (而那正是它第一次发生时没人看出来的原因)。接待会话下 `injected` 为 false。
   *
   * **可选**:手工构造 `TurnResult` 字面量的地方(测试、`emptyTurn`)可以不带它,
   * 渲染侧按「未记录」如实呈现 —— 不假装有一份空的项目上下文。
   */
  readonly projectContext?: {
    readonly injected: boolean;
    readonly summary: string;
  };
  /** 是否收到了 agent_settled / agent_end */
  readonly settled: boolean;
  /**
   * **这一回合结束时「甲方那边没有下文」的现场**(2026-10-07 真机事故补)。
   *
   * ⚠️ **为什么它必须存在**:模型完全可能**想完了、也调完工具了,却不产出正文**
   * —— `stopReason` 正常是 `stop`,不抛错、不超时、不是中断、也没有任何 error。
   * 真机现场就是这一形态:业务经理先说一句「我先看下你之前留下的偏好」,调了两次
   * `memory_search`,拿到结果之后**又想了 3754 字符的 thinking 就结束了**。
   * 平台这一侧什么都不报,甲方在对话页上看到的画面是「**他答完了,然后就没有
   * 然后了**」—— 三分钟后只好发一句「然后呢」,而模型那一侧已经翻页,答非所问。
   *
   * **判据只有两条,都很窄**(宁可漏报也不误报 —— 作用域见 `serve.ts`):
   * - `no_text`:**整个回合一个字都没说**(`text` 为空)。最硬的那一种。
   * - `no_text_after_tools`:调过工具,而**最后一次工具结果之后没有正文**。
   *   真机那次就是这一条 —— 它有一句开场白,所以 `text` 并不为空。
   *
   * **它不是失败,只是没有下文** —— 所以是可选现场而不是 `failed`:要不要报由
   * 调用方按 `trigger` 决定(以工具收尾的工作项回合本就不是缺陷,甲方开口的才是)。
   *
   * **可选,理由与 {@link TurnResult.projectContext} 同一条**:手工构造 `TurnResult`
   * 字面量的地方(测试、`execution.ts` 的 `emptyTurn`)不带它。缺省按「未记录」处理,
   * **不假装**「没有下文」——`null`(显式记过:没有)与 `undefined`(压根没记)读面
   * 同形,这是 {@link projectContext} 已经定下的处置。
   */
  readonly unanswered?:
    | null
    | {
        readonly kind: "no_text" | "no_text_after_tools";
        /** 已经说出口的字数(可能是那句开场白) */
        readonly textChars: number;
        /** 白烧掉的推理字数 —— 这是「他其实想了很多」的证据 */
        readonly thinkingChars: number;
        /** 工具调用次数 */
        readonly toolCalls: number;
      };
  /**
   * 有超时收尾(不等于失败,但必须让调用方知道)。
   *
   * **两条路都会置真**:① `timeoutMs` 的收尾等待到点(旧语义);
   * ② 新的墙钟上界到点、真的打断并 abort 了会话。哪一条看 `timeout` 有没有值:
   * 有 = 墙钟上界打断的,那一份现场在 `timeout` 里。
   */
  readonly timedOut: boolean;
  /**
   * **墙钟上界的现场**(7-N:「见不到的现场等于没有现场」)。
   *
   * 只有 `wallClockTimeoutMs` 到点、`abort()` 真的发出去过时才存在。
   * `timedOut` 只说「超时了」;这一份才说得出「跑了多久、打断瞬间在跑哪个工具、
   * abort 有没有失败、SDK 有没有在宽限内收尾」—— 一个卡了 16 分钟的回合,
   * 事后要能看出它当时在干什么。
   *
   * **可选**:手工构造 `TurnResult` 的地方不带它;没有它 = 这一回合不是被
   * 墙钟上界打断的。
   */
  readonly timeout?: TurnTimeoutScene;
  /**
   * **这一回合花了多少 token**(已落库的那一份,与 `turn_usage` 那一行同源)。
   *
   * **可选**:`calls === 0` 时**没有它** —— 一个没买到任何 LLM 输出的回合
   * (拒绝执行、prompt 立刻炸)不写账,也不假装记了一笔 0。
   *
   * 存在的理由与 `timeout` 同一条(7-N):「它写的账对不对」要能在**回合的产物里**
   * 看出来,而不用去库里按时间戳猜哪一行是刚才那次跑的。
   */
  readonly usage?: TurnUsageTotal;
}

/**
 * 墙钟上界到点时的现场。
 *
 * 它存在的唯一理由是 7-N:超时如果没有现场,「模型在原地打转」与「某个工具
 * 真的跑了很久」在事后完全无法区分 —— 而这决定了该改提示词还是该改工具超时。
 */
export interface TurnTimeoutScene {
  /** 到点的那个上界(毫秒)—— 现场要能自证判据 */
  readonly limitMs: number;
  /** 从 `prompt()` 发出到打断,实际跑了多久(毫秒) */
  readonly elapsedMs: number;
  /** `session.abort()` 有没有真的被调到。**false 才是异常**(死接线的形态) */
  readonly abortRequested: boolean;
  /**
   * `abort()` 自己失败时的错误文本。
   *
   * ⚠️ 尽力而为:`abort()` 是异步的,若它的失败是在本回合**返回之后**才报出来,
   * 这里会是 `null` —— 那条现场在 ERROR 日志里(不静默,见 `runTurn` 的实现)。
   */
  readonly abortError: string | null;
  /** 打断瞬间**正在跑**的那个工具(还没收到 tool_execution_end 的) */
  readonly interruptedTool: {
    readonly name: string;
    readonly argsSummary: string;
    /** 它已经跑了多久(毫秒) */
    readonly runningMs: number;
  } | null;
  /** 打断时已经**完成**的工具调用次数 */
  readonly completedToolCalls: number;
  /** abort 之后 `session.prompt()` 有没有在宽限内返回(false = SDK 没收敛) */
  readonly promptReturned: boolean;
  /** 打断让 `prompt()` 以错误收尾时的错误文本(中断不等于故障,但要留痕) */
  readonly promptError: string | null;
}

export interface RunTurnOptions {
  readonly session: AgentSession;
  readonly db: Database.Database;
  readonly agentId: string;
  /**
   * 当前项目。**`null` = 接待会话**(还没有项目,见 migrations/012)。
   *
   * 接待会话没有项目可查待办,所以此时**不注入**待办段(而不是拼一个空壳)。
   */
  readonly projectId: string | null;
  /** 本次要它做的事 */
  readonly message: string;
  /** 是否把待办拼进消息(默认 true;接待会话下强制不注入) */
  readonly injectPending?: boolean;
  /**
   * **收尾等待**的上界(毫秒,默认 {@link DEFAULT_TIMEOUT_MS} = 5 分钟)。
   *
   * ⚠️ **这不是「一个回合最多跑多久」** —— 它护的是
   * 「`session.prompt()` resolve 之后,等 `agent_settled` / `agent_end` 那段
   * 等待」,而且它**不打断** `prompt()` 自己。真要给回合一个时长上界,用
   * {@link RunTurnOptions.wallClockTimeoutMs}。两者的区别见文件头。
   */
  readonly timeoutMs?: number;
  /**
   * **把这条会话的库内历史重放进这一回合**(2026-10-07 真机事故补)。
   *
   * ⚠️ **只在「SDK 会话是刚建出来的」那一次传** —— 会话还活着的时候,历史本来就在
   * SDK 那一侧,再塞一遍就是让模型把同一段对话读两次。调用点唯一的判据是
   * `getOrCreateSession` 命中缓存与否(见 `serve.ts`),**不猜**。
   *
   * ⚠️ **必须排除本回合自己的那条用户消息**:`handleUserMessage` 是**先落库、
   * 再跑回合**的,不排除就会把甲方这句话在 prompt 里出现两遍。
   *
   * 完整理由与取舍见 {@link renderConversationHistory}。
   */
  readonly conversationHistory?: {
    readonly sessionId: string;
    readonly excludeMessageId?: string;
  };
  /**
   * **一个回合的墙钟上界**(毫秒,默认 {@link DEFAULT_WALL_CLOCK_TIMEOUT_MS}
   * = 10 分钟)。到点**调 `AgentSession.abort()` 真的打断这个回合**,
   * 而不是继续等一个不会收敛的 `prompt()`。
   *
   * 非正数一律退化成默认值(与 CLI 的 `--max-cascade-rounds` 同一条规矩:
   * 坏值取默认,而不是「0 = 不设上界」—— 那等于把唯一的上界悄悄拆掉)。
   */
  readonly wallClockTimeoutMs?: number;
  /**
   * `abort()` 发出之后,再等 `session.prompt()` 收尾的**宽限**上界(毫秒,
   * 默认 {@link DEFAULT_ABORT_GRACE_MS})。
   *
   * 存在的理由:排空器下「一个卡死的回合」会一直占着该项目的 busy 闩
   * (这正是本缺陷的后果之一)。宽限到点还没返回就不再等它 —— 宁可如实报
   * 「abort 之后没收敛」,也不让整条流水线被一个回合钉住。
   *
   * 暴露出来是为了可测:测试里传几十毫秒就能穷举「abort 之后 prompt 永不返回」
   * 这条路径,而不必真等 15 秒。
   */
  readonly abortGraceMs?: number;
  /** 逐事件观察(调试/日志)。抛错会被吞掉,不影响回合 */
  readonly onEvent?: (ev: AgentSessionEvent) => void;
  /**
   * **这条回合跑在哪条会话里**(`project_sessions.id`),写进 `turn_usage.session_id`。
   *
   * ⚠️ **`runTurn` 自己不知道它,也不去猜**:同一个项目里可以有多条会话
   * (`internal` + 每场交付一条 `client`),按 `(projectId, agentId)` 反推是哪一条
   * 会得到**一个看起来对、换一个场景就错**的答案 —— 而错的那个 `session_id`
   * 在事后无法与正确的区分。所以只能由**调用方**传(它手里就是 `ensureSession`
   * 的返回值)。
   *
   * 缺省不传 ⇒ 落 `NULL`。⚠️ `NULL` 在 018 里的含义是「接待会话,或那条会话已被
   * 删」;「调用方没传」是第三种含义,会与它撞在一起 —— 这是个**已知的诚实缺口**,
   * 不是设计。宿主两处调用点(`runAgentTurn` / `runWorkInSession`)各补一个实参即可
   * 消掉它(见批次报告)。
   */
  readonly sessionId?: string;
  /**
   * 这一回合在干哪个工作项,写进 `turn_usage.work_id`。
   * 缺省 `null`(= 聊天 / 汇报 / 评审的回合不挂工作项)。
   */
  readonly workId?: string;
  /**
   * id 生成(注入是为了可测:测试要能钉住落库行的 id)。
   * 缺省 `tu_<uuid>` —— 与全库的 `prefix_xxx` 同形。
   */
  readonly newId?: (prefix: string) => string;
  /**
   * **用量落库之后的回调**(实时推送的接缝)。
   *
   * `runTurn` 不持有 WS 枢纽(它连 `transport` 都不该知道),所以推送必须由
   * 宿主接线:`onUsageRecorded: (row) => hub.emitUsageRecorded(row.projectId, row)`。
   *
   * ⚠️ **它抛错不影响回合**(与 `onEvent` 同一条规矩)—— 但**不会**被静默:
   * 失败会记一条 ERROR 日志。这一点与「写账失败」同等处置:账已经落了,
   * 推送失败是传输问题,不是账目问题。
   */
  readonly onUsageRecorded?: (row: TurnUsageRow) => void;
}

/**
 * `timeoutMs` 的缺省值(5 分钟)—— **收尾等待**的上界,不是回合时长。
 * 导出是为了让文档与 CLI/宿主接线有个单一真相,不必各自抄一个数字。
 */
export const DEFAULT_TIMEOUT_MS = 300_000;

/**
 * **一个回合的墙钟上界**的缺省值(10 分钟)。
 *
 * 为什么是 10 分钟(判据是真机观测,不是拍脑袋):
 *   - 正常回合 **2–3 分钟**(worker 读代码 / 跑命令 / 写工件);
 *     10 分钟 ≈ 它的 3–5 倍,不会误杀正常回合;
 *   - 真机那条卡死的回合跑了 **16 分钟**还在 `bash` curl 文档 ——
 *     10 分钟把它砍掉约 40%,而且**打断**而不是「等它自己结束」;
 *   - 它同时是排空器下 busy 闩的最长持有时间:一个项目不会被一个回合
 *     无限期锁住。
 *
 * 保守方向是刻意的:上界太紧会杀掉**真正在做长活**的合法回合(跑一次全量
 * 测试、装依赖),那类误杀比多花几分钟贵得多。真需要更长的项目由调用方显式调大。
 */
export const DEFAULT_WALL_CLOCK_TIMEOUT_MS = 600_000;

/**
 * `abort()` 之后等 `prompt()` 收尾的宽限(15 秒)。
 * 只用于「宽限之后不再等」的判定,不参与回合时长上界。
 */
export const DEFAULT_ABORT_GRACE_MS = 15_000;

/**
 * 打断一个会话 —— 与批次 19 接在宿主 `interrupt` 上的那一套语义**同一份**:
 *
 *   - SDK 的取消入口是 `AgentSession.abort()`,**没有**别的路
 *     (`AbortController` 传不进 `session.prompt()`);
 *   - 它是 async 且会等到 agent 真正 idle,所以调用方**不 await** 它
 *     (但 `abort()` 在调用本函数的那一刻就被发起了:async 函数体同步执行到
 *     第一个 `await` 为止);
 *   - 但它失败**必须留现场**(7-N),所以错误文本被返回而不是吞掉 ——
 *     前端中断按钮曾经在「没人 set 的 inflight」里静默了整条链路。
 *
 * 返回 `null` = 已经发出且没有失败(或还在收尾中)。
 */
export async function requestSessionAbort(session: AgentSession): Promise<string | null> {
  try {
    await session.abort();
    return null;
  } catch (err: unknown) {
    return err instanceof Error ? err.message : String(err);
  }
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 事件类型收窄 —— 避免为读字段而上宽断言。 */
function isMessageUpdate(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "message_update" }> {
  return ev.type === "message_update";
}
function isToolStart(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "tool_execution_start" }> {
  return ev.type === "tool_execution_start";
}
function isToolEnd(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "tool_execution_end" }> {
  return ev.type === "tool_execution_end";
}
/**
 * 收窄到 `message_end`。
 *
 * ⚠️ **读点只有这一个,不许挪到 `message_start` / `message_update`**:
 * 那两处事件上的 usage 键**在、值全零**(T1 探针实测)。挪过去的表现不是
 * 「报错」,而是「每一行都是 0」—— `tests/platform/turn-usage-write.test.ts`
 * 里有一条变异验证钉着它(把读点改过去,那条测试必须红)。
 */
function isMessageEnd(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "message_end" }> {
  return ev.type === "message_end";
}

/**
 * usage 里的一个 token 数。
 *
 * 非有限值(`NaN` / `Infinity` / 类型不对)按 0 记 —— 与 018 的
 * 「`DEFAULT 0` 让『provider 没报这一项』与『真的是 0』在写入侧是同一种写法」
 * 一致。负数也按 0:SDK 的契约是非负整数,出现负数说明读错了字段,
 * 而「读错了字段」**要能被看见**(见下面的 `warnIfAllZero`),不是静默夹住。
 */
function tokenCount(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0;
}

/**
 * 从 `message_end` 的 `message` 上读一次 LLM 调用的用量 —— **读的那一刻就拷成值**。
 *
 * 返回 `null` = 这条消息不是 assistant,或它压根没有 usage 对象。
 * 形状不认识时**不抛**:一个读不出来的事件不该让整轮对话崩掉
 * (与 `openedProjectIdOf` 同一条规矩)。
 *
 * 写这个函数时**不 import `@earendil-works/pi-ai` 的 `Usage` 类型**是有意的:
 * 那会把「SDK 的实际字段名」变成编译期断言,而 SDK 改名时我们希望**运行期**
 * 仍然读得到一个可解释的结果(全零 + WARN),而不是整个平台编译不过。
 */
function usageSnapshotOf(message: unknown): TurnUsageCall | null {
  if (message === null || typeof message !== "object") return null;
  const m = message as { role?: unknown; usage?: unknown; model?: unknown };
  if (m.role !== "assistant") return null;
  const u = m.usage;
  if (u === null || typeof u !== "object") return null;
  const rec = u as { input?: unknown; output?: unknown; cacheRead?: unknown };
  return {
    input: tokenCount(rec.input),
    output: tokenCount(rec.output),
    cacheRead: tokenCount(rec.cacheRead),
    model: typeof m.model === "string" && m.model !== "" ? m.model : null,
  };
}

/** 缺省的 id 生成:与全库 `prefix_xxx` 同形,不引第三方依赖。 */
const defaultUsageId = (prefix: string): string => `${prefix}_${randomUUID()}`;

/**
 * 一整回合的 token 全为 0 时的告警。
 *
 * **为什么必须有这一条**:T1 的教训是「字段名给错过一次」
 * (`inputTokens` / `outputTokens` 根本不存在,真实的是 `input` / `output`)。
 * 若 SDK 哪天再改一次名,这里的读取会**全部读成 0** —— 那是一条**看起来完全
 * 正常**的账(每回合都花了 0 token),而「provider 没报用量」也会是同一个形状。
 * 两种原因在库里分不开,但**至少要留下现场**:一行 WARN 带上是几次调用。
 */
function warnIfAllZero(
  agentId: string,
  total: { input: number; output: number; cacheRead: number },
  calls: number,
): void {
  if (total.input + total.output + total.cacheRead > 0) return;
  log.warn(
    `turn: ${agentId} 的回合落了 ${calls} 次 LLM 调用的 usage,但 token 全为 0 —— ` +
      `要么 provider 没报用量(合法),要么 SDK 的字段名变了(读的是 ` +
      `input/output/cacheRead,见 pi-ai 的 Usage 类型)。两者在库里长得一样,` +
      `所以这条日志是唯一的现场。`,
  );
}

/** 把一回合里各次调用的 usage 求和。`calls` 为 0 时返回 `null`(不写账)。 */
function sumUsage(
  calls: readonly TurnUsageCall[],
): { input: number; output: number; cacheRead: number; model: string | null } | null {
  if (calls.length === 0) return null;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  const models = new Set<string>();
  for (const c of calls) {
    input += c.input;
    output += c.output;
    cacheRead += c.cacheRead;
    if (c.model !== null) models.add(c.model);
  }
  return {
    input,
    output,
    cacheRead,
    // 恰好一个模型才写它;混用多个写 null(一列装不下两个,写其中一个 = 假归属)
    model: models.size === 1 ? [...models][0]! : null,
  };
}

function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length <= n ? one : `${one.slice(0, n)}…`;
}

/**
 * 判断一次工具调用是否失败。
 *
 * **优先读结构化 details** —— `ToolExecutionEndEvent.isError` 只在 `execute` 抛异常
 * 时为 true,而我们的工具把失败作为文本返回(好让模型能读到并自纠),所以那个
 * 字段恒为 false。首跑实测:一次外键失败被日志标成了 ✓。
 *
 * 退路是读文本前缀(格式由适配壳固定),这样即便 details 缺席也不至于漏判。
 */
function toolCallFailed(ev: { isError?: unknown; result?: unknown }): boolean {
  if (ev.isError === true) return true;
  const details = (ev.result as { details?: unknown } | null | undefined)?.details;
  if (details !== null && typeof details === "object" && "ok" in details) {
    return (details as { ok?: unknown }).ok === false;
  }
  return resultText(ev.result).startsWith("[工具失败:");
}

/**
 * 从一次工具调用的结果里取出它声明的「新立项项目 id」。
 *
 * **只在 `project_open` 上读**:`ToolResult.data` 是通用逃逸口,它的含义由工具自己
 * 决定 —— 别的工具完全可能带一个 `projectId`(比如「我刚读的是哪个项目」)。
 * 不按工具名过滤的话,那种数据会被当成立项,而宿主会据此**迁移接待会话**。
 * 这里宁可写死一个工具名,也不留下那个误判面。
 *
 * **读结构化 details,不解析文本** —— 理由见 `TurnResult.openedProjectIds`。
 * 形状不认识时返回 null(不抛):一个读不出来的结果不该让整轮对话崩掉。
 */
function openedProjectIdOf(ev: { toolName?: unknown; result?: unknown }): string | null {
  if (ev.toolName !== "project_open") return null;
  const details = (ev.result as { details?: unknown } | null | undefined)?.details;
  if (details === null || typeof details !== "object") return null;
  const data = (details as { data?: unknown }).data;
  if (data === null || typeof data !== "object") return null;
  const id = (data as { projectId?: unknown }).projectId;
  return typeof id === "string" && id !== "" ? id : null;
}

/** 从工具结果里抠出文本。形状不认识就退化成 JSON,不抛。 */
function resultText(result: unknown): string {
  if (result === null || result === undefined) return "";
  if (typeof result === "string") return result;
  if (typeof result !== "object") return String(result);
  const content = (result as { content?: unknown }).content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const c of content) {
      if (c !== null && typeof c === "object" && "text" in c) {
        const t = (c as { text?: unknown }).text;
        if (typeof t === "string") parts.push(t);
      }
    }
    if (parts.length > 0) return parts.join("\n");
  }
  try {
    return JSON.stringify(result);
  } catch {
    return "(无法序列化的工具结果)";
  }
}

/** 参数摘要:id 之类的短字段保留,长文本截断。 */
function argsSummary(args: unknown): string {
  if (args === null || args === undefined) return "";
  if (typeof args !== "object") return truncate(String(args), 120);
  const entries = Object.entries(args as Record<string, unknown>);
  if (entries.length === 0) return "";
  return truncate(
    entries
      .map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`)
      .join(" "),
    160,
  );
}

/**
 * 拼出这一回合真正发给模型的内容。
 *
 * 待办在前、任务在后,并用一条分隔线明确层次 —— 否则模型会把「待办清单里的
 * 某一条」当成它这回合要做的事。
 */
export function composeTurnMessage(
  pendingBlock: string,
  message: string,
): string {
  if (pendingBlock.trim() === "") return message;
  return `${pendingBlock}\n\n---\n\n# 本次要做的事\n\n${message}`;
}

/** 重放时一条消息最多带多少字符 —— 超了截断并标出来,不假装完整。 */
const HISTORY_ITEM_MAX = 800;
/** 重放最多带多少条 —— 取**最近**这些(甲方刚说的那几条才是他在接着说的)。 */
const HISTORY_MAX_MESSAGES = 12;

/**
 * 把这条会话在库里的历史渲染成一段「此前对话」,拼在本回合消息**前面**。
 *
 * ⚠️ **为什么需要它**(2026-10-07 真机事故):SDK 会话是**纯内存**的,平台一行都不
 * 从 `~/.sansheng/agent/sessions/*.jsonl` 读回来 —— 服务一重启,常驻会话全部作废,
 * 下一条消息建出来的是**一条全新的、空的** SDK 会话。而**对话页读的是库**,于是
 * 屏幕上那一段对话明明是连续的,模型那侧却只剩最后一句话。
 *
 * 真机现场:甲方 09:53 问「docker 里量化系统怎么配 dev/prod + CI/CD」,业务经理回了
 * 一句「我先看下你的偏好」就停了;09:56:56 服务重启;09:57 甲方问「然后呢」——
 * **模型那一侧从来没有见过第一个问题**,于是它照着库里三个 `done` 项目回了
 * 一份「挑一个」的菜单。答得不算离谱,但答的是另一个问题。
 *
 * **为什么不走 SDK 自己的 `SessionManager.open`**:SDK 的会话文件按时间戳命名,
 * 平台从来没记过「哪个 `project_sessions.id` 对应哪个文件」,对上也对不上;
 * 而**库才是这个平台自己的真相**(迁移表、接待会话的 `DELETE`、立项时消息迁移
 * 都在改它)。从库里重放,顺带把「立项后消息被搬走」这种变化也一起跟上。
 *
 * **只重放「说过的话」**(`user` / `assistant`):`system` 是平台内部通知
 * (见 `announceDrain` / `reportUnannouncedTurn` 那两个生产者),它本来就不进对话页,
 * 摆给模型只会凭空多出平台自说自话的内容。
 *
 * @returns 空串 = 没有可重放的历史(**不要**拼一个空壳,理由同 `pendingBlock`)。
 */
export function renderConversationHistory(
  db: Database.Database,
  sessionId: string,
  opts: { readonly excludeMessageId?: string } = {},
): string {
  const rows = listSessionMessages(db, sessionId, HISTORY_MAX_MESSAGES).filter(
    (r) =>
      r.id !== opts.excludeMessageId &&
      (r.kind === "user" || r.kind === "assistant"),
  );
  if (rows.length === 0) return "";

  const lines = rows.map((r) => {
    const who = r.kind === "user" ? "甲方" : roleLabelOf(db, r.agentId);
    const body =
      r.content.length > HISTORY_ITEM_MAX
        ? `${r.content.slice(0, HISTORY_ITEM_MAX)}…（已截断，原文 ${r.content.length} 字符）`
        : r.content;
    // **缩进多行**:正文里有换行时,不缩进的话第二行会看起来像新的对话条目。
    return `- ${who}：${body.split("\n").join("\n  ")}`;
  });

  return [
    "## 此前对话（平台从库里查出来的，不是甲方这句话里说的）",
    "",
    "服务重启过，所以这条会话在你这一侧是空的。下面是**已经发生过**的对话：",
    "**不要重新回答它**，也不要假设甲方还在问那些问题——下面「本次要做的事」才是现在的。",
    "",
    ...lines,
  ].join("\n");
}

/** 说话人标签 —— 查不到 agent 时如实退到 `agent_id`,不假装知道角色名。 */
function roleLabelOf(db: Database.Database, agentId: string | null): string {
  if (agentId === null) return "甲方";
  const row = db.prepare(`SELECT role FROM agents WHERE id = ?`).get(agentId) as
    | { role?: unknown }
    | undefined;
  return typeof row?.role === "string" && row.role !== "" ? row.role : agentId;
}

/**
 * 跑一个回合。
 *
 * **不 dispose 会话** —— 一个回合只是一次交互,会话的生死由调用方决定。
 * (smoke 命令那种「问一句就关」是一次性用法,不是这里的形态。)
 */
export async function runTurn(opts: RunTurnOptions): Promise<TurnResult> {
  const text: string[] = [];
  const thinking: string[] = [];
  const toolCalls: ToolCallRecord[] = [];
  const openedProjectIds: string[] = [];
  // toolCallId → 开始时间 + 参数摘要。**参数必须在 start 时抓** ——
  // end 事件只给结果,不回头带参数,而「它拿什么参数调的」正是排查时最需要的现场。
  // 名字也在这里留一份:超时打断时「哪个工具正在跑」只能从这张表里看(7-N)。
  const inflight = new Map<
    string,
    { name: string; startedAt: number; argsSummary: string }
  >();
  /**
   * 本回合各次 LLM 调用的用量**快照**(不是引用 —— 见文件头那段)。
   *
   * 顺序 = 事件到达顺序,对求和没有影响(加法可交换),所以不额外排序:
   * 引入一个会漂的次序只会让「同一份数据两次跑出不同结果」多一个来源。
   */
  const usageCalls: TurnUsageCall[] = [];
  let settled = false;

  // ── 待办注入 ──
  // 接待会话(projectId === null)**不注入**:还没有项目,没有项目内的待办可列;
  // 拼一个空壳只会白占 context 并让模型以为「系统替我列过了」。
  const pid = opts.projectId;
  const work =
    opts.injectPending !== false && pid !== null
      ? collectPendingWork(opts.db, opts.agentId, pid, Date.now())
      : null;
  const pendingBlock = work !== null ? renderPendingWork(opts.db, work) : "";
  const pendingSummary =
    work !== null
      ? summarizePendingWork(work)
      : pid === null
        ? "(接待会话:没有项目待办)"
        : "(未注入)";

  // ── 项目上下文注入(A)──
  // **与待办同一个位置、同一条理由**:都是「每回合现算的现场」。拼进系统提示
  // 会把建立那一刻的快照当成永久事实(理由全文见 projectContext.ts 文件头)。
  // 接待会话返回空串,这里无脑拼接 —— 那条路径的行为与改动前完全一致。
  const ctx = renderProjectContext(opts.db, opts.agentId, pid);
  const body = composeTurnMessage(pendingBlock, opts.message);
  // 此前对话在最外层、项目上下文之内 —— 它是「这之前发生过什么」,比项目快照更早。
  const history =
    opts.conversationHistory !== undefined
      ? renderConversationHistory(opts.db, opts.conversationHistory.sessionId, {
          ...(opts.conversationHistory.excludeMessageId !== undefined
            ? { excludeMessageId: opts.conversationHistory.excludeMessageId }
            : {}),
        })
      : "";
  const withHistory = history === "" ? body : `${history}\n\n---\n\n${body}`;
  const payload = ctx.text === "" ? withHistory : `${ctx.text}\n\n${withHistory}`;

  /**
   * 「最后一次工具结果之后有没有正文」—— `unanswered` 的第二条判据。
   *
   * 用**事件到达顺序**判,不用文本比对:工具结果是正交的第四类消息,正文与它混在
   * 一起时没有任何一个 `text_delta` 能说明「这句话是在工具之前还是之后说的」。
   * 真机那次正是这么丢的:开场白(工具之前)被当成了这一回合的答复。
   */
  let textSinceLastTool = false;

  const unsub = opts.session.subscribe((ev: AgentSessionEvent) => {
    try {
      opts.onEvent?.(ev);
    } catch {
      // 观察者出错不该毁掉回合一 —— 但也不能静默:记进 thinking 之外的地方
      // 会污染语义,所以只保证不影响主流程。
    }

    if (isMessageUpdate(ev)) {
      const u = ev.assistantMessageEvent;
      // 7-I 的现场:thinking 增量曾被当成正文展示(判据写成了不存在的
      // "thinking")。这里**显式分开**,两者永不混流。
      if (u.type === "text_delta" && typeof u.delta === "string") {
        text.push(u.delta);
        textSinceLastTool = true;
      } else if (u.type === "thinking_delta" && typeof u.delta === "string") {
        thinking.push(u.delta);
      }
      return;
    }

    // ── ★ 用量读点:只有这里 ──────────────────────────────────────
    // `message_start` / `message_update` 上的 usage **键在、值全零**;
    // `message_end` 是唯一「事件时刻即终值」的投递。而 `turn_end` /
    // `agent_end.messages` 是**同一条消息的第二次 / 第三次投递** ——
    // 三条路逐项相等,累加两条就是对同一份用量收两遍钱。
    //
    // 这里读出来的是**值的快照**(`usageSnapshotOf` 只取三个数字),
    // 所以「事件时刻」这个前提是机器保证的,不依赖任何后来才读的引用。
    if (isMessageEnd(ev)) {
      const snap = usageSnapshotOf(ev.message);
      if (snap !== null) usageCalls.push(snap);
      return;
    }

    if (isToolStart(ev)) {
      inflight.set(ev.toolCallId, {
        name: ev.toolName,
        startedAt: Date.now(),
        argsSummary: argsSummary(ev.args),
      });
      return;
    }

    if (isToolEnd(ev)) {
      const started = inflight.get(ev.toolCallId);
      toolCalls.push({
        name: ev.toolName,
        argsSummary: started?.argsSummary ?? "",
        isError: toolCallFailed(ev),
        resultSummary: truncate(resultText(ev.result), 300),
        durationMs: started !== undefined ? Date.now() - started.startedAt : 0,
      });
      // 工具结果落地 = 又一个「该说话」的时点。从这里起若再没有正文,甲方那边
      // 就是断的(见 `TurnResult.unanswered`)。
      textSinceLastTool = false;
      // 立项是**流程状态变更**,必须单独留痕:宿主靠它做「接待会话 → 新项目」
      // 的切换。失败的结果不会带 data(见 sdkAdapter 的失败分支)。
      const opened = openedProjectIdOf(ev);
      if (opened !== null) openedProjectIds.push(opened);
      inflight.delete(ev.toolCallId);
      return;
    }

    if (ev.type === "agent_settled" || ev.type === "agent_end") settled = true;
  });

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 非正数 → 默认值(坏值取默认;「0 = 不设上界」等于把唯一的上界悄悄拆掉)
  const wallClockMs =
    opts.wallClockTimeoutMs !== undefined && opts.wallClockTimeoutMs > 0
      ? opts.wallClockTimeoutMs
      : DEFAULT_WALL_CLOCK_TIMEOUT_MS;
  const abortGraceMs =
    opts.abortGraceMs !== undefined && opts.abortGraceMs > 0
      ? opts.abortGraceMs
      : DEFAULT_ABORT_GRACE_MS;

  let timedOut = false;
  const startedAt = Date.now();

  // ── 墙钟超时的现场(7-N)────────────────────────────────────────
  // 到点那一刻抓,而不是返回时抓:「跑了多久」指的是**被打断时**跑了多久。
  let wallClockExceeded = false;
  let abortRequested = false;
  let abortError: string | null = null;
  let interruptedTool: TurnTimeoutScene["interruptedTool"] = null;
  let elapsedAtInterruptMs = 0;
  let completedAtInterrupt = 0;
  let promptReturned = false;
  let promptErrorValue: unknown = undefined;
  let promptErrorMessage: string | null = null;
  let releaseWallClock: () => void = () => {};
  const wallClockReached = new Promise<void>((resolve) => {
    releaseWallClock = resolve;
  });

  /** 落库那一行的现场(见 `TurnResult.usage`);没写账时为 `undefined`。 */
  let recordedUsage: TurnUsageTotal | undefined;

  // ⚠️ **登记必须发生在第一次 `await` 之前。** 放在 `await opts.session.prompt()`
  // 之后等于永远登记不上:到点时回合早就结束了(或者早就该被打断了)——
  // 批次 19 修前端中断时,死接线正是藏在这个缝隙里(一个从来没人 `set` 的
  // `inflight`,于是 `get()` 恒 undefined、可选链把整条链路吞得一声不响)。
  const wallClockTimer = setTimeout(() => {
    wallClockExceeded = true;
    timedOut = true;
    elapsedAtInterruptMs = Date.now() - startedAt;
    completedAtInterrupt = toolCalls.length;

    // 打断瞬间**正在跑**的那个工具就是现场:只写一句「超时了」,
    // 事后分不清「模型在原地打转」与「某个工具真的跑了很久」(7-N)。
    let running: { name: string; startedAt: number; argsSummary: string } | null = null;
    for (const rec of inflight.values()) {
      if (running === null || rec.startedAt > running.startedAt) running = rec;
    }
    interruptedTool =
      running === null
        ? null
        : {
            name: running.name,
            argsSummary: running.argsSummary,
            runningMs: Date.now() - running.startedAt,
          };

    // **WARN 级日志 + 现场**:超时不许静默(见文件头与 7-N)
    log.warn(
      `turn: 墙钟上界 ${wallClockMs}ms 到点 —— 正在打断 ${opts.agentId} 的回合` +
        `(已跑 ${elapsedAtInterruptMs}ms · 已完成工具 ${completedAtInterrupt} 次 · ` +
        (interruptedTool === null
          ? "打断瞬间没有正在跑的工具"
          : `打断瞬间在跑 ${interruptedTool.name}(${interruptedTool.runningMs}ms)` +
            (interruptedTool.argsSummary !== "" ? ` 参数:${interruptedTool.argsSummary}` : "")) +
        ")",
    );

    // 与宿主 `interrupt` 完全同一套语义:SDK 的取消入口就是 `AgentSession.abort()`。
    // **不 await**(它是 async 且会等到 agent 真正 idle,定时器回调不该被阻塞),
    // 但失败要留现场 —— 前端中断曾经因为「没人 set 的 inflight」静默失效过。
    abortRequested = true;
    void requestSessionAbort(opts.session).then((err) => {
      if (err === null) return;
      abortError = err;
      log.error(`turn: 打断 ${opts.agentId} 的回合失败(abort 报错):${err}`);
    });

    // 收尾等待立刻结束:不再等一个已经被我们打断的回合收敛
    settled = true;
    releaseWallClock();
  }, wallClockMs);

  // `timeoutMs` 的定时器**保持原样**:它护的是「prompt() 返回之后等收敛事件」
  // 那段等待。它与上面那个墙钟上界是两件事,不合并(见文件头)。
  const timer = setTimeout(() => {
    timedOut = true;
    settled = true;
  }, timeoutMs);

  /**
   * 把这一回合的用量落成**一行**(`turn_usage` 是回合级的,见 `migrations/018`)。
   *
   * ── 为什么它写在 `finally`(而调用点只有一个)──────────────────
   *
   * `runTurn` 有**两条出口**:正常返回,以及 `prompt()` 自己失败时
   * `throw promptErrorValue`。后者同样可能已经买到了 LLM 输出(前几次调用成功、
   * 后面某次失败),把它漏掉就是**静默少账** —— 钱花了、账上没有。
   * `finally` 对两条出口各跑一次,所以它既满足「单点写入」,又不漏掉失败路径。
   *
   * **幂等策略 = 单点写入 + 不重试**(任务书已定),不是「按某个键去重」:
   * 表里没有能识别「同一个回合」的天然键,而为此加一列会把幂等变成需要
   * 跨进程协商的事实 —— 这里没有那个需要。调用方重跑一个回合 = 新的一回合
   * = 新的一行,那也确实是**新花掉的钱**。
   *
   * 写账失败**不毁回合**(账目是账目,回合是回合),但绝不静默:ERROR 日志里带
   * 上这一次的量与项目,事后看得出「这笔钱没记上」。失败时返回 `undefined` ——
   * **没落进去就不能说落了**,`TurnResult.usage` 因此缺席。
   *
   * ── 已知的边界(如实写)──────────────────────────────────────
   *
   * 墙钟上界打断时 `settled` 被置真,收尾循环会退出;此后若 SDK 再投递一条
   * `message_end`,它在 `unsub()` 之后到达,于是**不计入本行**。这是有界的:
   * 打断之后 SDK 要么已经投递完,要么在 `abortGraceMs` 宽限内不收尾 ——
   * 那一条用量会落在下一次(重跑)的账上,而不是消失两遍。
   */
  const recordTurnUsage = (): TurnUsageTotal | undefined => {
    const total = sumUsage(usageCalls);
    // 没买到任何 LLM 输出(拒绝执行 / prompt 立刻炸)⇒ **不写账**。
    // 写一行 0 会把它变成「这个回合花了 0」的假事实。
    if (total === null) return undefined;

    const rowId = (opts.newId ?? defaultUsageId)("tu");
    warnIfAllZero(opts.agentId, total, usageCalls.length);

    const row: TurnUsageRow = {
      id: rowId,
      projectId: pid,
      sessionId: opts.sessionId ?? null,
      agentId: opts.agentId,
      workId: opts.workId ?? null,
      model: total.model,
      inputTokens: total.input,
      outputTokens: total.output,
      cacheRead: total.cacheRead,
      createdAt: Date.now(),
    };

    try {
      insertTurnUsage(opts.db, row);
    } catch (err: unknown) {
      log.error(
        `turn: 用量落库失败(${opts.agentId} · 项目 ${pid ?? "(接待会话)"} · ` +
          `input=${total.input} output=${total.output} cacheRead=${total.cacheRead} ` +
          `来自 ${usageCalls.length} 次 LLM 调用)—— 这笔钱记不上了:` +
          (err instanceof Error ? err.message : String(err)),
      );
      return undefined;
    }

    // 实时推送的接缝:账**已经落了**才回调。抛错不影响回合(与 onEvent 同一条
    // 规矩),但要留现场 —— 传输失败是传输问题,不是账目问题。
    if (opts.onUsageRecorded !== undefined) {
      try {
        opts.onUsageRecorded(row);
      } catch (err: unknown) {
        log.error(
          `turn: 用量 ${rowId} 已落库,但 onUsageRecorded 抛错(推送可能没发出去):` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }

    return { input: total.input, output: total.output, cacheRead: total.cacheRead, calls: usageCalls.length, rowId };
  };

  try {
    // `prompt()` 的结局显式接住(而不是直接 `await`),因为两条路都可能有错:
    // 普通失败要照旧抛给调用方;而**墙钟打断时它抛错是预期结果**,不是回合故障
    // (宿主 `interrupt` 那条路同样是「中断不是故障」)。不接住的话,
    // 一次超时会被上层报成「回合失败」,处置与落点就都变了。
    const promptPromise = opts.session.prompt(payload).then(
      () => {
        promptReturned = true;
      },
      (err: unknown) => {
        promptReturned = true;
        promptErrorValue = err;
        promptErrorMessage = err instanceof Error ? err.message : String(err);
      },
    );

    await Promise.race([promptPromise, wallClockReached]);

    // `prompt()` 自己失败(不是我们打断的)→ **立刻**抛给调用方。
    // 不能拖到收尾等待到点:那会把「provider 报错」变成「卡满 timeoutMs 才报错」,
    // 而且会先把 settled 置真、把错误伪装成一次超时收尾。
    if (promptErrorMessage !== null && !wallClockExceeded) throw promptErrorValue;

    if (wallClockExceeded && !promptReturned) {
      // abort 已经发出,给 SDK 一个**有界**的收尾宽限。绝不无限等:
      // 一个卡死的回合会把排空器的 busy 闩一直握住(本缺陷的后果之一)。
      await Promise.race([promptPromise, delay(abortGraceMs)]);
      if (!promptReturned) {
        log.warn(
          `turn: abort 之后 ${abortGraceMs}ms 内 session.prompt() 仍未返回 —— ` +
            `不再等它(回合按超时收尾;排空器不会被一个回合钉住)`,
        );
      }
    }
    if (wallClockExceeded && promptErrorMessage !== null) {
      // 中断不是故障(与宿主 `interrupt` 同一条判断),但要留痕:错误文本进现场
      log.muted(
        `turn: ${opts.agentId} 的回合被墙钟上界打断,prompt() 以错误收尾:${promptErrorMessage}`,
      );
    }

    while (!settled) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearTimeout(wallClockTimer);
    clearTimeout(timer);
    // 先退订再写账:晚到的 `message_end` 不该落进**上一个**回合的账
    // (`message_end` → 求和 → 落库 是一个同步块,中间不会插进新事件)。
    unsub();
    // ★ 单点写入 —— `finally` 对「正常返回」与「prompt() 抛错」两条出口各跑一次
    recordedUsage = recordTurnUsage();
  }

  const timeout: TurnTimeoutScene | undefined = wallClockExceeded
    ? {
        limitMs: wallClockMs,
        elapsedMs: elapsedAtInterruptMs,
        abortRequested,
        abortError,
        interruptedTool,
        completedToolCalls: completedAtInterrupt,
        promptReturned,
        promptError: promptErrorMessage,
      }
    : undefined;

  // ── 「甲方那边没有下文」的判据(2026-10-07)──────────────────────
  //
  // **打断与超时一律不算**:那两条路已经有各自的现场与告警(`timeout` / 中断日志),
  // 在这里再报一次「没下文」等于把一个已知状态说成另一个,反而更难查。
  const turnText = text.join("");
  const unanswered: TurnResult["unanswered"] =
    abortRequested || timedOut
      ? null
      : turnText.trim() === ""
        ? {
            kind: "no_text",
            textChars: 0,
            thinkingChars: thinking.join("").length,
            toolCalls: toolCalls.length,
          }
        : toolCalls.length > 0 && !textSinceLastTool
          ? {
              kind: "no_text_after_tools",
              textChars: turnText.trim().length,
              thinkingChars: thinking.join("").length,
              toolCalls: toolCalls.length,
            }
          : null;

  return {
    text: turnText,
    thinking: thinking.join(""),
    toolCalls,
    openedProjectIds,
    pending: { injected: pendingBlock.trim() !== "", summary: pendingSummary },
    projectContext: { injected: ctx.text.trim() !== "", summary: ctx.summary },
    settled: !timedOut,
    unanswered,
    timedOut,
    ...(timeout !== undefined ? { timeout } : {}),
    ...(recordedUsage !== undefined ? { usage: recordedUsage } : {}),
  };
}

/**
 * 把墙钟超时的现场渲染成几行(7-N:见不到的现场等于没有现场)。
 *
 * 单独导出,因为两处报告都要它:`renderTurnReport`(一个回合)与
 * `execution.ts` 的 `renderExecutionReport`(一个工作项)。超时的现场
 * 恰好是「事后最想看到、而最容易只写一句『超时』」的那部分。
 */
export function renderTimeoutScene(s: TurnTimeoutScene): string[] {
  const lines: string[] = [
    `⏱ 墙钟上界 ${s.limitMs}ms 到点 → 已${s.abortRequested ? "" : "**未**"}调用 session.abort() 打断` +
      `(实际跑了 ${s.elapsedMs}ms,已完成工具 ${s.completedToolCalls} 次)`,
  ];
  lines.push(
    s.interruptedTool === null
      ? "  打断瞬间没有正在跑的工具"
      : `  打断瞬间在跑:${s.interruptedTool.name}(${s.interruptedTool.runningMs}ms)` +
        (s.interruptedTool.argsSummary !== "" ? ` 参数:${s.interruptedTool.argsSummary}` : ""),
  );
  if (!s.abortRequested) lines.push("  ⚠️ abort() 没有被调到 —— 这个回合没有被真正打断");
  if (s.abortError !== null) lines.push(`  ⚠️ abort() 自己失败了:${s.abortError}`);
  if (!s.promptReturned) {
    lines.push("  ⚠️ abort() 之后 session.prompt() 在宽限内没有返回(SDK 未收敛)");
  }
  if (s.promptError !== null) lines.push(`  打断让 prompt() 以错误收尾:${s.promptError}`);
  return lines;
}

/**
 * 把回合结果渲染成可读报告(CLI / 日志用)。
 *
 * 含**现场**:调了哪些工具、哪些失败。一个只有回答的日志在排查时等于没有日志。
 */
export function renderTurnReport(r: TurnResult): string {
  const lines: string[] = [];
  const pc = r.projectContext;
  lines.push(
    `项目上下文: ${
      pc === undefined ? "未记录" : pc.injected ? pc.summary : "无(接待会话)"
    }`,
  );
  lines.push(`待办注入: ${r.pending.injected ? r.pending.summary : "无"}`);
  // 「没有下文」必须出现在**这一份**报告里 —— 它是排查「甲方说他没回话」时
  // 唯一能一眼认出的那行(真机现场:日志里当时什么都没有)。
  // `!= null` 同时挡掉 `undefined`(手工构造的字面量没带这个字段)。
  if (r.unanswered != null) {
    lines.push(
      r.unanswered.kind === "no_text"
        ? `⚠️ 这一回合一个字都没说(白想了 ${r.unanswered.thinkingChars} 字符)`
        : `⚠️ ${r.unanswered.toolCalls} 次工具结果之后没有正文` +
          `(开场白 ${r.unanswered.textChars} 字符,之后又想了 ${r.unanswered.thinkingChars} 字符)`,
    );
  }
  if (r.toolCalls.length > 0) {
    lines.push(`工具调用 ${r.toolCalls.length} 次:`);
    for (const t of r.toolCalls) {
      lines.push(
        `  ${t.isError ? "✖" : "✓"} ${t.name} (${t.durationMs}ms)` +
          (t.argsSummary !== "" ? `\n      参数:${t.argsSummary}` : "") +
          (t.resultSummary !== "" ? `\n      结果:${t.resultSummary}` : ""),
      );
    }
  } else {
    lines.push("工具调用: 无");
  }
  if (r.openedProjectIds.length > 0) {
    lines.push(`本回合立项: ${r.openedProjectIds.join(", ")}`);
  }
  if (r.usage !== undefined) {
    // 只报 token,**不报金额** —— `cost` 刻意既不落库也不展示(用户已定)
    lines.push(
      `本回合用量: input ${r.usage.input} · output ${r.usage.output} · ` +
        `cacheRead ${r.usage.cacheRead}(来自 ${r.usage.calls} 次 LLM 调用 · 已落库 ${r.usage.rowId})`,
    );
  }
  if (r.thinking !== "") lines.push(`(另有 ${r.thinking.length} 字符内部推理,未混入正文)`);
  if (r.timeout !== undefined) lines.push(...renderTimeoutScene(r.timeout));
  if (r.timedOut) lines.push("⚠️ 回合超时收尾 —— 结果可能不完整");
  return lines.join("\n");
}
