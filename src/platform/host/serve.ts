/**
 * 平台宿主 · `sansheng platform serve`
 *
 * ── 它补的是设计里漏掉的那个阶段 ──────────────────────────────
 *
 * 前 12 个批次把机制建扎实了,但平台**没有长驻进程** —— `bootPlatform` 只有
 * CLI 一个调用方,`src/platform/` 内没有任何 daemon。后果是三件事同时被卡:
 *
 *   1. 界面用不了(只能命令行驱动)
 *   2. `client.*` 不闭环(`ClientChannel` 只有日志实现,问题到不了用户)
 *   3. 调度器没地方待(写出来就是死代码)
 *
 * 这个文件是那三件事的公共前置。
 *
 * ── 会话生命周期 ────────────────────────────────────────────────
 *
 * 每个项目一条连续对话(经校准的裁决),所以每个项目**常驻一个 Pi 会话**。
 * 每条用户消息都重建会话会丢掉 `toolLoop` 的历史,而历史正是「它已经查过
 * 什么」的来源(7-N:每轮重拼 transcript 导致模型原地打转)。
 *
 * ── 事件桥 ──────────────────────────────────────────────────────
 *
 * `runTurn` 给的是 SDK 的 `AgentSessionEvent`,前端要的是 `ServerEvent`。
 * 桥接在这里做,而且**text 与 thinking 分两条流**(7-I 的现场:判据写错导致
 * 1853 字符内部推理被当成正式回复展示给用户)。
 */
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server } from "node:http";
import type Database from "better-sqlite3";
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { bootPlatform, type BootedPlatform } from "../runtime/boot.js";
import { createPlatformSession, type CreateSessionFn } from "../runtime/session.js";
import { runTurn, type TurnResult, type ToolCallRecord } from "../runtime/turn.js";
import { runWorkItem } from "../runtime/execution.js";
import { ORG, ensureOrg, orgReady } from "../runtime/org.js";
import {
  drainProject,
  formatIdleTrail,
  type DrainResult, type DrainTurnReport, type DrainWorkReport,
} from "../runtime/dispatcher.js";
import { createPlatformApp } from "../transport/http.js";
import { attachHub, clientFacingAgentId, ensureSession, PlatformHub } from "../transport/hub.js";
import { startFixedDelay, startScheduler, type FixedDelayLoop, type Scheduler } from "./scheduler.js";
import { resetPlatformData } from "./reset.js";
import {
  appendSessionMessage, type SessionChannel,
} from "../storage/repo/sessions.js";
import { ROLE_SPECS } from "../identity/role.js";
import { resolveClientQuestion } from "../tools/client.js";
import { listProjectSummaries, type LiveCollectOptions } from "../transport/views.js";
import { getProjectRow, listProjects } from "../storage/repo/projects.js";
import { getWork } from "../storage/repo/works.js";
import { getAgent } from "../storage/repo/agents.js";
import { log } from "../../shared/log.js";
import { applySettingsPatch, toPublicSettings } from "../infra/settingsApply.js";
import { listProviders, resolveModel, syncActiveProviderApiKeyEnv } from "../infra/providers.js";
import { listPendingDispatchEvents } from "../storage/repo/dispatch.js";
import {
  todoKindReachesClient,
  type ServerEvent, type TriggerTodoKind, type TurnTrigger,
} from "@shared/types/platform.js";

// ══ 检测器:工件触发的回合没留工作记录(W2-③)══════════════════════════
//
// ── 为什么需要它(真机证据,不是假想)────────────────────────────
//
// 提示词要求(`harness/system_prompts/business_manager.core.md`「每个回合的正文
// 都以一行工作记录开头」):**平台把你叫醒的回合,没调 `tell_client` 的,正文第一行
// 就必须是 `[未播报] …`**。理由是 7-N —— 少了这一行,「**判断过**」与「**漏了**」
// 在会话记录里长得一模一样,而这一行是它们唯一的分界。
//
// 真机复核:`[未播报]` 在**全库 0 条**。⇒ 提示词可能压不住,而提示词是软的。
// 所以这里加一条**平台侧检测**,命中就落一条**平台自己的**告警 ——
// ⚠️ **绝不替模型补那一行日志**:平台上补的字会被后来的读者当成
// 「业务经理当时判断过了」,那是**编造现场**,比没有现场更坏。
//
// ── 判据的四个条件:哪几个真能拿到 ───────────────────────────────
//
//   ① **工件触发** —— **真值**。`trigger` 由 `drainProject` 经
//      `DrainDeps.runAgentTurn` 的 `todoKind` 形参传进来(那里是唯一同时持有
//      「待办」与「回合」的地方);本文件不再从 `agentId` 反推。
//   ② **本回合 ≥1 条未消费事件** —— ⚠️ **回合级的形式拿不到**。
//      `dispatch_events` 的未消费行是**项目级**的,而叫醒业务经理的那条
//      `report_downstream` 待办**不携带事件身份**(`refs: []`,key 只有
//      `report_downstream:{maxSeq}`)⇒「**这一回合属于哪几条事件**」这个绑定
//      **库里根本不存在**,平台也读不出来。所以它**不进判据**,改成:
//      **真读一次项目级未消费条数**(`listPendingDispatchEvents`),作为**现场**
//      记进告警(见 `UnannouncedTurn.pendingEventCount`)—— 它是现场,不是闸门。
//      ⚠️ 把它当闸门的两个坏处都是实的:(a) 在非 `report_downstream` 的回合上
//      它是**别的事件**的读数(相邻噪音);(b) 判据会从「平台叫醒的回合」
//      缩到「下游事件叫醒的回合」,而提示词那条规矩覆盖的是**前者**。
//   ③ **未调 `tell_client`** —— **真值**(`turn.toolCalls`)。只认**成功**的调用:
//      调用失败 = 没播出去 = 仍然要留痕。
//   ④ **正文无行首 `[未播报]`** —— **真值**。判据是 `WORK_LOG_LINE`,
//      与前端 `web/src/components/chat/MessageList.tsx` 的 `splitWorkLog`
//      **逐字同形**(重复一份的理由:契约面 `shared/` 与 `web/` 都不归本批改;
//      漂了的表现是「平台认、界面不认」或反过来 —— 见报告里的 open question)。
//
// ── 只在「回合成功结束」这一支调用它 ─────────────────────────────
//
// 失败 / 被中断的回合**不**算:那时 `dispatch_events` 不会被消费
// (`dispatcher.ts` 的 `if (!aborted && !failed)`),证据还在,下一轮还会重来
// —— 在那一支上报警是**误报**。反过来,成功的 `report_downstream` 回合
// **紧接着**就会把它们标成已交代(`consumePendingDispatchEvents`),那一行
// 正文是它们**唯一**的现场。

/**
 * 工作记录的**行首**判据。
 *
 * `^` 是**行首**(不是包含):正文中段引述 `"[未播报]"` 不算 —— 那是**对甲方说的话**。
 * `[ \t]*` 允许行首的水平空白(提示词示例写在代码块里);破折号开头的列表项
 * (`- [未播报] …`)因此**不**匹配 —— 那已经是一条正文。
 *
 * ⚠️ 与 `web/src/components/chat/MessageList.tsx` 的 `WORK_LOG_LINE` 必须一致:
 * 平台按它判「留没留痕」,界面按它判「分不分流」。两处不一致 = 平台报「合规」
 * 而甲方在气泡里看到那行字(或反过来)。
 */
const WORK_LOG_LINE = /^[ \t]*\[未播报\]/;

/** 告警里带的**正文前若干字** —— 够定位「它当时写了什么」,不把正文整段抄进告警。 */
export const UNANNOUNCED_TEXT_HEAD_CHARS = 120;

/** 检测命中时的现场(平台自己的产物,不含任何补写的正文)。 */
export interface UnannouncedTurn {
  /** 平台是因为哪一类待办把它叫醒的(`trigger.todoKind`) */
  readonly todoKind: TriggerTodoKind;
  /** 正文前若干字(截断)—— 7-N:事后要能看出当时它写了什么 */
  readonly textHead: string;
  /** 本回合调了 `tell_client` 几次(全是失败时也 >0 —— 见 `tellClientDelivered` 的判据) */
  readonly tellClientCalls: number;
  /** 收尾时**项目级**未消费事件的条数(真读;不是回合级的读数 —— 见文件头) */
  readonly pendingEventCount: number;
}

/** 这一回合**有没有把播报发出去**:只认**成功**的 `tell_client`。 */
function tellClientDelivered(toolCalls: readonly ToolCallRecord[]): boolean {
  return toolCalls.some((t) => t.name === "tell_client" && !t.isError);
}

/**
 * 判据本体(**纯函数**,导出给测试)。
 *
 * 返回 `null` = 不命中(不是工件触发的回合 / 调过 `tell_client` / 正文留了痕)。
 * 返回对象 = 命中,调用方落一条平台告警(见 `host/serve.ts` 的
 * `reportUnannouncedTurn`)。
 *
 * ⚠️ **它不产出任何正文**:`textHead` 是从**模型自己写的**正文里截出来的原样
 * 片段,`[未播报]` 那一行**永远不会**由平台补写。
 */
export function detectUnannouncedTurn(input: {
  readonly trigger: TurnTrigger;
  /**
   * 这个回合的正文**会不会进甲方通道**(`channelForAgent`:只有 `clientFacing`
   * 的角色是 `client`,今天 = 业务经理一个人)。
   *
   * ⚠️ 这不是一条可有可无的加严:那条「没播就得留一行 `[未播报]`」的规矩
   * **只写给业务经理**(`business_manager.core.md`)。项目经理拆解、质检审查
   * 这些**平台叫醒的内部回合**同样满足「工件触发 + 没调 `tell_client`」,
   * 但它们**根本没有对甲方的通道** —— 提示词从没要求过它们留痕。
   * 把它们也算命中 = 每个项目一开张就连着几条假告警,而假告警会把这条计数
   * 变成噪音(那时它就不再是「提示词压不住」的证据了)。
   */
  readonly channel: SessionChannel;
  readonly text: string;
  readonly toolCalls: readonly ToolCallRecord[];
  readonly pendingEventCount: number;
}): UnannouncedTurn | null {
  // ⓪ 只有**对甲方说话**的那个角色有这条规矩(今天 = 业务经理)
  //
  // ⚠️ **2026-10-06 真机修的一处**:这三类待办的正文**自动进甲方通道**了
  // (`CLIENT_FACING_TODO_KINDS`,读面 `web/src/lib/data.ts` 的 `channelOf`
  // 第 4 步按同一个闭合集判定)。所以对它们再要求「必须调 `tell_client`
  // 才算已播报」,就是**要求他在已经是甲方通道的地方再广播一次** ——
  // 而那会把告警从「真信号」变成每 tick 一条的噪音,比没有告警更糟。
  //
  // 真机依据:同一个项目里业务经理 `tell_client` 调用 0 次 / 24 次 todo 回合,
  // 而 `resume_client` 那一条里他写着「一个关键张力我必须当面说清」——
  // 那条正文此前被读面整条滤掉,甲方从头到尾不知道自己的两个拍板互相打架。
  // 判据这一侧改完之后,这类正文**不需要他做任何事**就到甲方眼前了。
  if (input.channel !== "client") return null;
  // ① 工件触发 = 平台叫醒的回合。甲方亲口触发的那一轮(`{ kind: "user" }`)
  //    不在提示词那条规矩的作用域里:它的正文**本来就是**对甲方说的话,
  //    不必再挂一个「我没播」的标记(见 `business_manager.core` 那处例外)。
  if (input.trigger.kind !== "todo") return null;
  // ①-bis 正文已经自动进甲方通道的那三类 → 没有「没播报」这回事。
  if (todoKindReachesClient(input.trigger.todoKind)) return null;
  // ③ 没把播报发出去
  if (tellClientDelivered(input.toolCalls)) return null;
  // ④ 正文留了行首标记
  if (input.text.split("\n").some((line) => WORK_LOG_LINE.test(line))) return null;
  return {
    todoKind: input.trigger.todoKind,
    textHead: input.text.slice(0, UNANNOUNCED_TEXT_HEAD_CHARS),
    tellClientCalls: input.toolCalls.filter((t) => t.name === "tell_client").length,
    pendingEventCount: input.pendingEventCount,
  };
}

export interface ServeOptions {
  readonly dataDir: string;
  readonly host: string;
  readonly port: number;
  readonly cwd?: string;
  readonly version: string;
  /** 打开浏览器 */
  readonly open?: boolean;
  /**
   * **单次级联最多跑几个 agent 回合**。默认 8。
   *
   * 这是烧 token 的硬上界(见 `runtime/driver.ts` 的 ③)。单用户本地服务里
   * 「一次用户消息引爆 20 个回合」既贵又难排查,所以默认值刻意保守,而它**可配**:
   * 项目大、链子长时把它调大,而不是把上界从代码里拿掉。
   */
  readonly maxCascadeRounds?: number;
  /**
   * 调度器扫描间隔(毫秒)。默认 60 秒。
   *
   * 它是**超时提问**那条周期的间隔,与排空器无关(排空的兜底有自己的
   * `dispatchIntervalMs`)。测试里调小它,就能在合理时间内观察到超时提示。
   */
  readonly schedulerIntervalMs?: number;
  /**
   * **排空器兜底定时器的间隔(毫秒)**。默认 10 秒,fixed-delay 语义
   * (上一轮排空跑完再等这么久,所以两轮永不重叠)。
   *
   * 它的职责是兜底:重启恢复、事件 nudge 漏掉的、以及外部直接改库的场合。
   * 调小它 = 兜底更及时、空转更频繁;调大它 = 更省,但状态迁移后要等更久。
   */
  readonly dispatchIntervalMs?: number;
  /**
   * **执行类回合**的超时上限(毫秒)。缺省交给 `runTurn` 自己的默认值(5 分钟)。
   *
   * 执行一个工作项会真的读代码 / 跑命令,所以它与「聊天回合」的合理上限不是
   * 同一个数 —— 这里给它一个独立的旋钮,而不是让两件事共用一个默认。
   */
  readonly turnTimeoutMs?: number;
  /**
   * **一个 agent 回合的墙钟上界(毫秒)**。缺省交给 `runTurn` 的
   * `DEFAULT_WALL_CLOCK_TIMEOUT_MS`(10 分钟)。
   *
   * 与 `turnTimeoutMs` **不是同一个东西**,这也是它必须单独有一个旋钮的理由:
   *   - `turnTimeoutMs` 护的是「`prompt()` resolve 之后等 `agent_settled` 那段」,
   *     **不打断** `prompt()` 自己;
   *   - `turnWallClockMs` 到点会真的调 `AgentSession.abort()` 打断这个回合。
   *
   * Wave 1 把判定与打断做完了,但**运行期只能吃默认值** —— 宿主没有把它接出去,
   * 于是「调了上界」与「它根本没生效」在真机上长得一样。这里补上那条线。
   */
  readonly turnWallClockMs?: number;
  /**
   * **合并唤醒**的两个旋钮(见 `runtime/dispatcher.ts` 的 `collectTodos`)。
   *
   * 下游事件不再「有一条就生成一次汇报待办」,而是:
   *   - `reportBatchSize`(缺省 3):攒够这么多条就叫醒业务经理一次;
   *   - `reportMaxDelayMs`(缺省 5 分钟):最老的那条等了这么久就叫醒一次
   *     —— 它是**延迟上界**,保证事件不可能永远等不到叫醒。
   *
   * `work_failed` 与 severity ≥ high 的阻塞**绕过这两个条件,立刻叫醒**。
   */
  readonly reportBatchSize?: number;
  readonly reportMaxDelayMs?: number;
  /**
   * **同时排空几个项目**(默认 3)。
   *
   * ⚠️ 这是**唯一**限制「全局同时在烧多少 token」的东西。并发之后
   * `maxCascadeRounds` / `dispatch_attempts` / `turnWallClockMs` **全都按项目记**,
   * 没有任何一条是按进程记的 —— 所以项目的并发数就是全局花费的代理指标,
   * 它必须是一个硬上界,而不是「尽力而为」。
   *
   * 并行**不止在项目之间**:同一个项目内部**甲方那条路 ⊥ 排空那条路**也会并行
   * (忙闩的键是 `(项目, agent)`,不是项目 —— 见 `PlatformHub.busy` 的注视)。
   * 项目内那一路的串行分别由上界与忙闩管:排空**内部**逐回合串行(`drainProject`
   * 一条一条 `await`),而「同一个角色不许两条流打进同一条常驻会话」由忙闩管。
   */
  readonly maxConcurrentProjects?: number;
  /**
   * **给每个项目一个独立的工作目录**(默认**关**)。
   *
   * 打开时:会话的 `cwd` = `<工作根>/projects/<projectId>`,接待会话仍是工作根本身。
   * 它挡的是 SDK 的**按绝对路径的文件变更队列**造成的跨项目耦合
   * (`pi-coding-agent/dist/core/tools/file-mutation-queue.js` 的
   * `withFileMutationQueue(filePath, fn)`:`edit` / `write` 先 `resolveToCwd(path, cwd)`
   * 再按绝对路径排队)—— 同一路径串行(**不会损坏文件**),不同路径并行。
   * 于是两个项目的 worker 若用**同一个相对路径**,今天会解析到同一个绝对路径 →
   * 排队、后写覆盖先写 = 语义冲突。独立 cwd 让同一个相对路径落在不同目录。
   *
   * ── 为什么默认关(这条与「D4 要做」的裁决不一致,理由在证据里)──────
   *
   * 打开它会**改掉已有项目的相对路径根**:工作根里已经产出的文件(真机现场:
   * `~/sansheng-workspace/` 下就摆着当前唯一那个项目的交付物)在新根下**看不见**,
   * 而没有任何东西会告诉 worker「你的文件搬走了」——那是一次静默破坏。
   * 而收益(两个项目同时改同一个相对路径)需要 ≥2 个项目同时开工才发生:
   * 真机库 `SELECT COUNT(*) FROM projects` = 1。所以顺序是「先把工作根搬进
   * 项目子目录,再打开这个开关」,而不是反过来。
   * 机制、测试与开关都在,打开只需一个参数(或 CLI 一行,见报告)。
   */
  readonly isolateProjectCwd?: boolean;
  /**
   * 测试 seam:替换真实的 `createAgentSession`(与 `session.ts` 的 DI 同一条理由 ——
   * 「到底把什么交给了 SDK」/「中断有没有到达会话」这类断言不该需要 provider 与网络)。
   * 生产不传。
   */
  readonly createSession?: CreateSessionFn;
}

const HERE = fileURLToPath(new URL(".", import.meta.url));

export interface PlatformHost {
  readonly app: Hono;
  readonly hub: PlatformHub;
  readonly booted: BootedPlatform;
  readonly scheduler: Scheduler;
  /** 排空器的兜底触发(fixed-delay) */
  readonly dispatchTimer: FixedDelayLoop;
  /** 关掉所有常驻会话与库 */
  close(): void;
  /** 当前常驻会话数(诊断用) */
  sessionCount(): number;
}

/**
 * 装配宿主(不监听)。测试可以直接拿 `app` 打请求,不必占端口。
 */
export function createPlatformHost(opts: ServeOptions): PlatformHost {
  const booted = bootPlatform({ dataDir: opts.dataDir, clientLog: (l) => log.muted(l) });
  const db = booted.deps.db;
  const now = booted.now;
  const newId = booted.newId;

  const cwd = opts.cwd ?? booted.settings.cwd;

  /**
   * 某个上下文的会话工作目录(D4)。
   *
   * **默认就是工作根本身**(`opts.isolateProjectCwd` 未打开)—— 这条默认值是有
   * 证据的选择,不是懒:`settings.cwd` 是用户配的「工作根」,而设计文档明写
   * `code.*` **项目无关**(`harness/authorize.ts:126`),真机工作根里还摆着
   * 唯一那个项目已经产出的文件。打开隔离会把这些文件的相对路径根搬走,
   * 而没有任何东西会通知 worker。
   *
   * 打开后每个项目一个子目录。目录**必须真的存在**:SDK 的 `bash` 会
   * `fsAccess(cwd)` 并在不存在时报「Working directory does not exist」
   * (`pi-coding-agent/dist/core/tools/bash.js`),而 SDK 只建会话目录
   * (`SessionManager` 的 `sessionDir`),不建 cwd 本身。
   * 建不出来时**退回工作根**并留一行 warn —— 建目录失败不该让这个项目连会话
   * 都建不出来(那会把一个目录问题放大成「组织不动」)。
   */
  function sessionCwd(projectId: string | null): string {
    if (opts.isolateProjectCwd !== true || projectId === null) return cwd;
    const dir = join(cwd, "projects", projectId);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (e) {
      log.warn(
        `platform: 建项目 ${projectId} 的工作目录失败(${dir})—— 退回工作根 ${cwd}:` +
          `${e instanceof Error ? e.message : String(e)}`,
      );
      return cwd;
    }
    return dir;
  }

  /**
   * 当前模型。**可变** —— 用户在界面上改了 provider 之后必须换掉,
   * 否则会用 boot 时那个一直跑下去(而且他改了却没有效果,最难排查)。
   */
  let currentModel = booted.model;

  /** 重新按当前设置解析模型。写设置后调用。 */
  async function reResolveModel(): Promise<void> {
    const p = booted.settingsStore.activeProvider();
    if (p === undefined) {
      currentModel = null;
      return;
    }
    // 凭据要先同步到 env 再解析 —— 与 bootPlatform 里同一条理由
    syncActiveProviderApiKeyEnv(p.provider, p.apiKey);
    currentModel = resolveModel({
      provider: p.provider,
      modelId: p.modelId,
      apiKey: p.apiKey,
      baseUrl: p.baseUrl ?? null,
    });
    log.muted(`platform: 模型已重新解析 → ${currentModel !== null ? `${p.provider}/${p.modelId}` : "(失败)"}`);
  }

  // ── 常驻会话(键 = 上下文 + agent)────────────────────────────
  //
  // 原先键只是 `string | null`(一个上下文一个会话),因为**只有业务经理**
  // 会跑回合。驱动者循环一接上,同一个项目里项目经理 / worker / 质检**各要
  // 一条自己的会话**(工具面不同、提示词不同),所以键必须落到
  // `(上下文, agent)` 上 —— 否则三个角色会抢同一条会话,而那种错会表现成
  // 「项目经理用 worker 的工具面说话」。
  //
  // 上下文里的 `null` 仍然是**接待会话**(第一个项目之前),不引入哨兵值;
  // 编码成键只在池子内部用。
  const sessions = new Map<string, AgentSession>();

  /** 会话池的键。上下文 `null` = 接待会话。 */
  function pooledKey(projectId: string | null, agentId: string): string {
    return `${projectId ?? "<intake>"}::${agentId}`;
  }
  function contextPrefix(projectId: string | null): string {
    return `${projectId ?? "<intake>"}::`;
  }

  /** 丢掉某个上下文里**所有角色**的常驻会话(不存在时静默 —— 幂等调用点用它)。 */
  function disposeSessionsFor(projectId: string | null, why: string): void {
    const prefix = contextPrefix(projectId);
    let n = 0;
    for (const [key, s] of [...sessions]) {
      if (!key.startsWith(prefix)) continue;
      try {
        s.dispose();
      } catch {
        /* dispose 失败不影响「这条会话已经不该再用」这个事实 */
      }
      sessions.delete(key);
      n++;
    }
    if (n > 0) {
      log.muted(`platform: 已丢弃${channelLabel(projectId)}的 ${n} 条常驻会话(${why})`);
    }
  }

  /** 丢掉全部常驻会话(设置变更 / 数据重置 / 关闭)。 */
  function disposeAllSessions(why: string): void {
    const n = sessions.size;
    for (const s of sessions.values()) {
      try {
        s.dispose();
      } catch {
        /* dispose 失败不影响「它们已经不该再用」这个事实 */
      }
    }
    sessions.clear();
    if (n > 0) log.muted(`platform: 已丢弃全部 ${n} 条常驻会话(${why})`);
  }

  /**
   * **正在跑的回合**的登记表 —— `onInterrupt` 唯一能到达「那个回合」的路径。
   *
   * ⚠️ 这里曾经是一个 `Map<string | null, AbortController>`,而**从来没有人
   * `set` 过它**(只有声明 / `get` / `delete`)。后果是前端的中断按钮与 Esc
   * 一直是 no-op:`get()` 恒 undefined,可选链把整条链路吞得一声不响。
   * 那是「死接线」的教科书形态 —— 代码看起来齐全,功能从来没有过。
   *
   * 修法不是「给 AbortController 加一个 set」:SDK 的取消入口是
   * `AgentSession.abort()`(`AbortController` 根本传不进 `session.prompt`),
   * 所以登记的就是**那个会话自己的 abort**。
   *
   * ⚠️ **键是 `(上下文, agent)`(用 `pooledKey`),不是 `projectId`。**
   * 「同一个项目里两个角色同时在跑」在忙闩按项目记时是**不可达**的,所以按项目
   * 记的键看起来够用;忙闩一改成按 `(上下文, agent)`,它就从不可达变成**可达**,
   * 而按项目记会让**后登记的覆盖前一个** ⇒ 用户的中断只到得了最后一个回合
   * (R1 读出来的雷 (b))。键必须与「一个回合」同粒度。
   */
  const inflight = new Map<string, () => void>();

  const hub = new PlatformHub(
    { db, now, newId },
    {
      onUserMessage: async (projectId, content) => {
        await handleUserMessage(projectId, content);
      },
      onAnswerQuestion: async (questionId, answer) => {
        const r = resolveClientQuestion(db, questionId, answer, now(), {
          newId,
          answeredByAgentId: "bm",
        });
        if (!r.ok) {
          hub.broadcast({
            type: "error",
            error: { code: r.reason ?? "internal", message: `答复失败:${r.reason}` },
          });
          return;
        }
        // 项目从提问工件上取 —— 答复事件也要带 projectId,否则前端不知道该
        // 更新哪个项目面板(按项目分组呈现)
        const projectId = getClientQuestionProject(questionId);
        if (projectId !== null) {
          hub.broadcast({
            type: "client_question_answered",
            projectId,
            questionId,
            decisionArtifactId: r.decisionArtifactId ?? "",
          });
        }
      },
      onInterrupt: (projectId) => {
        // ── 一次中断停掉这个上下文里**正在跑的每一个**回合 ─────────────
        //
        // 不是「随便一个」、更不是「最后一个」。旧键(`projectId`)下,同一个项目
        // 里两个角色并发时后登记的那条会**覆盖**前一条,于是用户的中断只到得了
        // 最后起来的那个回合 —— 那正是 R1 读出来的雷 (b),也正是忙闩改细之后
        // 会变成可达的那条路。
        //
        // ⚠️ **「只停某一个角色」在今天的协议上不可表达**:`ClientCommand.interrupt`
        // 只带 `projectId`(`shared/types/platform.ts`),角色维度没有上过线。
        // 所以这里给的是**超集**:能保证的是**不丢任何一个**,而不是「精确到角色」。
        const prefix = contextPrefix(projectId);
        const hit = [...inflight.entries()].filter(([k]) => k.startsWith(prefix));
        if (hit.length === 0) {
          // 幂等:没有正在跑的回合(用户连点两次、或回合刚好结束)不是错误。
          // 但**必须留一行日志** —— 否则「中断按钮没反应」和「真的没有活可停」
          // 在事后完全无法区分(7-N:见不到的现场等于没有现场)。
          log.muted(`platform: 收到中断,但${channelLabel(projectId)}上没有正在跑的回合 —— 忽略`);
          return;
        }
        log.ok(
          `platform: 中断${channelLabel(projectId)}正在跑的 ${hit.length} 个回合` +
            `(${hit.map(([k]) => k.slice(prefix.length)).join(", ")})`,
        );
        for (const [, abort] of hit) abort();
      },
    },
  );

  function getClientQuestionProject(questionId: string): string | null {
    const row = db
      .prepare(`SELECT project_id AS p FROM artifacts WHERE id = ?`)
      .get(questionId) as { p: string } | undefined;
    return row?.p ?? null;
  }

  /**
   * 用户在某个上下文里说了一句话 → 业务经理跑一个回合,全程流式推给前端。
   *
   * `projectId === null` = **接待会话**(第一个项目之前)。此时没有项目可校验,
   * 那条会话就是 `project_id IS NULL` 的全局唯一会话(见
   * `migrations/012_intake_session.sql`)。业务经理在这里与甲方谈诉求 ——
   * 谈拢之后由**它**调 `project_open`,本函数在回合结束后收口:
   * 把接待会话的消息迁进新项目、丢掉接待会话、广播 `project_opened` 让前端切过去。
   * **用户从不需要填「创建项目」表单**:立项是业务经理的动作。
   */
  async function handleUserMessage(projectId: string | null, content: string): Promise<void> {
    if (projectId !== null) {
      const project = getProjectRow(db, projectId);
      if (project === null) {
        hub.broadcast({ type: "error", projectId, error: { code: "not_found", message: "项目不存在" } });
        return;
      }
      if (project.status === "done" || project.status === "abandoned") {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "project_closed", message: `项目已${project.status === "done" ? "完成" : "废弃"},不能再对话` },
        });
        return;
      }
    }

    ensureOrg(db, now());
    const at = now();
    // **通道 = `client`(调用点显式声明)**:这是**甲方说的话**,它属于甲方通道。
    // 交付对话开出来之后它落在那场交付的对话里;开出来之前明确回退到项目内部会话
    // (交付之前不存在第二条对话)。接待会话(`projectId === null`)的通道由
    // `ensureSession` 内部按 `project_id IS NULL` 处置,与这个实参无关。
    const sessionId = ensureSession(db, projectId, at, newId, "client");

    // 1. 用户消息先落库 —— 落库和广播的顺序反了会出现「用户看见自己说了话,
    //    刷新后它没了」
    const userMessageId = newId("m");
    appendSessionMessage(db, {
      id: userMessageId, sessionId, agentId: null, kind: "user", content, createdAt: at,
      // **封套:回合 + `user`** —— 甲方亲口发起的那一轮(W3-① 落库)。
      // 它与下面 `hub.emitMessageStart(...)` 那一行是**同一份判据的两个落点**:
      // 一处给实时流,一处给刷新后的 REST 回填 —— 两边必须说同一件事。
      originSource: "turn", triggerKind: "user",
    });
    hub.emitMessageStart(projectId, userMessageId, "user", null, { kind: "user" });
    hub.emitDelta(projectId, userMessageId, content);
    hub.emitMessageEnd(projectId, userMessageId);

    // 2. 拿(或建)业务经理的常驻会话,跑一个回合,事件桥到前端
    const bm = ORG.find((m) => m.role === "business_manager")!;
    let openedProjectIds: readonly string[] = [];
    /** 这一回合结束后要不要敲一下门铃(排空哪个项目)。`null` = 不敲。 */
    let nudgeTarget: string | null = null;

    // 占用的是 **`(上下文, 业务经理)`** —— 受保护的资源是业务经理那条常驻会话,
    // 不是整个项目(项目里 worker / 质检在跑不该挡住甲方跟业务经理说话)。
    //
    // ⚠️ 这一次占用**必须同步**发生(在第一次 `await` 之前):hub 的 `send` 判据
    // 与它落在同一个 tick 里,否则两条挨着到的消息会双双通过判据(WS 的每条消息
    // 各自 fire-and-forget),那就是「同一个角色两条流打进同一条会话」的入口。
    hub.setBusy(projectId, bm.id, true, { kind: "user" });
    try {
      // ⚠️ `{ kind: "user" }` 是这一句的**唯一**合法值 —— 这一轮存在的原因就是
      // 甲方自己开了口(见 `runAgentTurn` 的 `trigger` 形参)。
      const out = await runAgentTurn(projectId, bm.id, content, { kind: "user" });
      openedProjectIds = out.openedProjectIds;

      // 3. 立项 → 收口。**必须在回合结束之后做** —— 回合中途换上下文会让半个
      //    回合的输出落进另一个面板(前端此刻还在接待流上)。
      if (openedProjectIds.length > 0) {
        // 一个回合里立了多个项目是病态输入;如实记账,并只迁到最后一个
        // (不静默挑一个:事后要能看出当时发生了什么)。
        const newProjectId = openedProjectIds[openedProjectIds.length - 1]!;
        if (openedProjectIds.length > 1) {
          log.warn(
            `platform: 一个回合里立了 ${openedProjectIds.length} 个项目 ` +
              `(${openedProjectIds.join(", ")})—— 接待会话只迁进最后那个 ${newProjectId}`,
          );
        }
        const row = getProjectRow(db, newProjectId);
        if (row === null) {
          // 工具说立项成功、库里却没有 —— 这是装配/写入事故,必须响亮
          log.error(`platform: project_open 报回 ${newProjectId},但库里读不到它 —— 不切换`);
        } else {
          const fromIntake = projectId === null;
          if (fromIntake) {
            // 顺序有讲究:**先迁消息,再广播,最后才丢会话**。
            //   迁 → 前端收到事件后立刻拉新项目的 messages,那时消息必须已经在了
            //       (否则用户会看到一段空对话)
            //   广播 → 放在 dispose 之前:dispose 是 SDK 的调用,不该由它决定
            //       用户多久才看到切换
            //   丢 → 接待会话的工具面是接待模式的,留着会让下一条消息继续用它
            adoptIntakeMessages(sessionId, newProjectId);
          }
          hub.emitProjectOpened(newProjectId, row.name);
          if (fromIntake) disposeSessionsFor(null, "立项后接待会话结束");
          log.ok(
            `platform: 已立项 ${newProjectId}「${row.name}」` +
              (fromIntake ? "(接待会话的消息已迁入)" : `(在项目 ${projectId} 的会话里立的)`),
          );
        }
      }

      // 4. 用户消息的回合结束后 → **敲一下门铃**(排空器的触发点之一)。
      //
      // ── 为什么**只在项目内**敲,接待会话里那次立项不敲 ──────────────────
      //
      // 接待会话里立起项目,用户此刻刚被切进那个新项目:他还没看过目标对不对,
      // 系统的第一个动作却已经是「项目经理拆解 + worker 开工 + 质检 + 业务经理
      // 汇报」—— 那是**在用户确认目标之前就花他的 token**。而且 `project_opened`
      // 之后紧接着一串流式输出,前端会在用户还没读完切换动作时就开始滚屏。
      //
      // 代价是明的:那一次立项之后,项目经理的「还没拆解」要等到用户下一次说话、
      // 或定时器下一次 fire 才被捡起来。这两条路都在,不是漏掉。
      if (projectId !== null) nudgeTarget = projectId;
    } finally {
      hub.setBusy(projectId, bm.id, false);
      // ⚠️ 这里**不再** `inflight.delete(projectId)`:那张表按 `(上下文, agent)`
      // 记,在上下文这一层删会把**别的角色**的登记一起抹掉(用户的中断随即
      // 找不到那个回合)。每个回合自己删自己那一条 —— 见 `runAgentTurn` /
      // `runWorkInSession` 的 `finally`。
    }

    // 门铃**不 await**:排空是平台自己的循环,用户那条消息的回合到这儿就结束了。
    // **按项目敲**:`drainOne` 的 busy 闩只挡得住同一个项目的重叠,而门铃按项目记
    // 才不会让「A 排空期间 B 敲门」被吞掉(见 `nudge` / `drainProjectLoop`)。
    if (nudgeTarget !== null) {
      nudge(nudgeTarget);
      // ── 唯一一次需要**全局**扫的门铃 ──────────────────────────────
      //
      // `project.open` 是**项目无关**能力,业务经理在项目里也持有它 —— 也就是说这个
      // 回合可能立起了**另一个**项目,而那个项目不在 `nudgeTarget` 里。旧实现
      // (门铃一律扫全部活跃项目)会顺手把它捡起来;按项目敲之后必须显式补这一下,
      // 否则它只能等下一个 tick(≤10s,不是错,但没必要丢掉这个信号)。
      //
      // ⚠️ **接待会话那次立项仍然不敲**(上面 `if (projectId !== null)` 已经挡住):
      // 那是刻意的 —— 用户还没看过目标,不该在他确认之前花他的 token。
      if (openedProjectIds.length > 0) nudge();
    }
  }

  // ── 会话池(上下文 + agent)──────────────────────────────────

  /**
   * 把接待会话的消息迁进新项目的会话,然后删掉接待会话行。
   *
   * **迁而不是留**:那段对话就是新项目的立项背景,它该跟着项目走 —— 甲方刷新
   * 之后在新项目里还看得见当初说过什么。删掉接待会话行是有意的:留着它就是一条
   * 空会话,而「全局只有一条接待会话」由 schema 的部分唯一索引保证
   * (见 migrations/012);下次点「新建项目」时会建一条干净的。
   *
   * ⚠️ 这里删的是 `project_sessions` 一行,**不是 DROP TABLE** ——
   * `session_messages` 对它有 `ON DELETE CASCADE`,所以顺序必须是
   * 「先把消息 UPDATE 走,再 DELETE 那条空会话」。反过来做会连消息一起级联删掉,
   * 而 `DROP TABLE` 那条路更糟(见 migrations/012 文件头:foreign_key_check 一声不响)。
   */
  function adoptIntakeMessages(intakeSessionId: string, newProjectId: string): void {
    // **通道 = `internal`**:接待迁移把历史搬进**项目主会话**。这一刻项目是刚
    // 立起来的,交付对话不可能存在(交付物都还没有),所以它**不会**误搬进
    // 交付对话;而接待那段历史是「立项背景」,属于项目内部会话的起点。
    const target = ensureSession(db, newProjectId, now(), newId, "internal");
    const moved = db
      .prepare(`UPDATE session_messages SET session_id = ? WHERE session_id = ?`)
      .run(target, intakeSessionId).changes;
    // 消息已经全部迁走,这里删掉的只是一条空会话(级联删不到东西)
    db.prepare(`DELETE FROM project_sessions WHERE id = ?`).run(intakeSessionId);
    log.muted(`platform: 接待会话 ${intakeSessionId} 的 ${moved} 条消息 → 项目 ${newProjectId} 的会话 ${target}`);
  }

  type SessionAcquire =
    | { readonly ok: true; readonly session: AgentSession }
    | { readonly ok: false; readonly code: string; readonly message: string };

  /**
   * 取(或建)某个 agent 在某个上下文里的常驻会话。
   *
   * **必须用 hub 的 channel**,不能用 `booted.deps` 里那个日志通道 —— 后者只打
   * 日志,问题到不了用户(真机验证时就是这样:工具跑了、工件建了、投递去了 stdout)。
   *
   * ── 为什么**接待会话不装门铃**(真机 E2E 抓到的洞)────────────────
   *
   * 门铃挂在工具调用上,而门铃一响排空器就会去查「现在该谁动」。接待会话里
   * `project_open` 刚把项目建出来的那一刻,新项目就已经是 active —— 于是门铃
   * 会在用户**还没看过项目目标**之前就叫醒项目经理去拆解、worker 去开工。
   * 这正是批次 20 明确定为**不该发生**的事(在他确认之前花他的 token)。
   *
   * (门铃现在是**按项目**记的 —— `nudge(projectId)`。这个洞的判断不因此改变:
   * 接待会话根本不该有门铃,而不是「门铃扫哪个项目」的问题。)
   *
   * 修法在**装配层**:接待会话的会话不带门铃(`projectId === null`)。项目内的
   * 迁移照旧敲门 —— 那里用户已经在项目里了。用户被切进新项目之后的第一句话
   * (`handleUserMessage` 末尾的 nudge)才是那条流水线的起点。
   */
  async function getOrCreateSession(
    projectId: string | null,
    agentId: string,
  ): Promise<SessionAcquire> {
    const key = pooledKey(projectId, agentId);
    const cached = sessions.get(key);
    if (cached !== undefined) return { ok: true, session: cached };
    if (currentModel === null) {
      return { ok: false, code: "no_model", message: "没有可用的 provider —— 先在设置里配一个" };
    }
    const created = await createPlatformSession(
      // `onStateChange` = 门铃:任何**可能改变流水线状态**的工具调用成功后,
      // 平台立刻去查一次「现在该谁动」(见 runtime/dispatcher.ts)。
      // 它不携带状态,判定永远重新查库 —— 回调里那个 `projectId` 只是**去哪查**。
      // **接待会话不装**(理由见本函数上面那一段):否则立项当场就把组织叫起来了。
      {
        ...booted.deps,
        client: hub.clientChannel,
        // 门铃挂**这个项目** —— 见 `nudge` 的注释:门铃按项目记,这样一个项目的
        // 排空不会吞掉另一个项目的敲门(D3)。
        ...(projectId !== null ? { onStateChange: () => nudge(projectId) } : {}),
      },
      agentId, projectId, {
        cwd: sessionCwd(projectId),
        agentDir: booted.settings.agentDir ?? join(opts.dataDir, "agent"),
        model: currentModel,
        dataDir: opts.dataDir,
        ...(opts.createSession !== undefined ? { createSession: opts.createSession } : {}),
      },
    );
    if (!created.ok) {
      return { ok: false, code: "session_failed", message: `${created.reason}:${created.detail}` };
    }
    sessions.set(key, created.session);
    log.muted(
      `platform: 建了 ${agentId} 在${channelLabel(projectId)}的会话` +
        `(工具面 ${created.plan.tools.length} 个 · 系统提示 ${created.wiring.systemPromptChars} 字符` +
        (created.wiring.missingPromptUnits.length > 0
          ? ` · ⚠️ 未落地单元 ${created.wiring.missingPromptUnits.join(",")}`
          : "") +
        ")",
    );
    return { ok: true, session: created.session };
  }

  /** 一次 agent 回合的返回形态(内部用)。 */
  interface AgentTurnOutcome {
    readonly aborted: boolean;
    readonly timedOut: boolean;
    readonly text: string;
    readonly toolCalls: readonly ToolCallRecord[];
    readonly openedProjectIds: readonly string[];
    /** 会话建不出来 / 抛错 —— 这一回合什么都做不了 */
    readonly failed: boolean;
    /**
     * **这一次没跑起来的一句话现场**(建会话失败的原因 / 抛错信息)。
     *
     * 7-N:排空器那条「N 次派发 · 其中 M 个真回合」的告警要能解释「没跑起来的是什么
     * 状况」,而这句原因只有宿主知道(它握着 `got.message` / 异常)。不带它的话,
     * 告警只能写「有 6 次没跑起来」——那仍然是一个说不清理由的数字。
     */
    readonly failureReason?: string;
  }

  /**
   * 跑一个 agent 回合:建(或取)会话 → 流式桥事件 → 落库 → 收尾。
   *
   * **忙闩的占用在调用方**(用户那条路是 `handleUserMessage`,排空那条路是
   * `withTurnLatch`),但粒度已经是 **`(上下文, agent)`** —— 也就是说它挡的是
   * 「同一个角色两条流打进同一条常驻会话」,而不是「这个项目里还有别的回合」。
   *
   * `inflight` 的登记**每回合一次、键是 `(上下文, agent)`**,这是刻意的:中断要能
   * 准确地停住**正在跑的那一个回合**,而不是「这个项目里随便哪个角色」。前者按
   * 项目记时,同项目两角色并发会让后登记的覆盖前一个(R1 的雷 (b))。
   *
   * ── `trigger`:**必填**,不给默认值 ─────────────────────────────
   *
   * 这一轮**为什么存在**要写进 `message_start` 的封套(`shared/types/platform.ts`
   * 的 `TurnTrigger`):`{ kind:"user" }` = 甲方亲口发起(`handleUserMessage`),
   * `{ kind:"todo", todoKind }` = 排空器按待办叫醒 —— 值由 `drainProject` 经
   * `DrainDeps.runAgentTurn` 的 `todoKind` 形参传进来,本文件**不从 `agentId` 反推**
   * (业务经理既会被甲方叫醒、也会被 `answer_ask` / `report_downstream` 叫醒,
   * 反推会得到一个「看起来对、换一个场景就错」的值,而错了的表现是
   * **工件触发的回合正文被当成对甲方说的话**进对话页 —— 静默判错)。
   *
   * ⚠️ **不给默认值是刻意的**(与 `agentId` 同一条纪律):默认值会让漏传的调用点
   * 编译通过,而漏传那一支恰好就是会判错的那一支。
   */
  async function runAgentTurn(
    projectId: string | null,
    agentId: string,
    task: string,
    trigger: TurnTrigger,
  ): Promise<AgentTurnOutcome> {
    const got = await getOrCreateSession(projectId, agentId);
    if (!got.ok) {
      hub.broadcast({
        type: "error", projectId,
        error: { code: got.code, message: `${agentId}:${got.message}` },
      });
      return {
        aborted: false, timedOut: false, text: "", toolCalls: [],
        openedProjectIds: [], failed: true,
        failureReason: `${got.code}:${got.message}`,
      };
    }
    const session = got.session;
    // **通道:按「这个角色是不是甲方接口」定**(调用点显式声明的那一条)。
    //
    // `runAgentTurn` 是本文件里**唯一**服务多个角色的调用点:业务经理
    // (`handleUserMessage`)与排空器叫醒的项目经理 / 质检 / 整合都走它。判据只有
    // 一条、而且是代码内常量:`ROLE_SPECS[role].clientFacing`(只有业务经理为
    // true)。甲方通道 = 甲方说的话 ∪ 面向甲方的角色的回合 —— 两边合起来才是
    // 「甲方看得见的那条对话」。
    //
    // 查不到这个 agent 时**取 `internal`(fail-closed)**:宁可让一条发言留在
    // 内部会话里,也不把可能是内部角色的发言塞进甲方通道 —— 与前端
    // `channelOf`(web/src/lib/data.ts)同一条纪律,连失效方向都一样。
    const sessionId = ensureSession(db, projectId, now(), newId, channelForAgent(db, agentId));
    const messageId = newId("msg");
    // 建轮那一刻就把说话人钉住 —— 这一条是**跑这个回合的那个 agent**(参数,不是常量):
    // `handleUserMessage` 传业务经理,排空器传项目经理 / 质检(见 `drainOne` 的回调)。
    // `trigger` 同理,而且是**两个互相独立**的维度(见 `TurnTrigger` 上方那张表)。
    hub.emitMessageStart(projectId, messageId, "assistant", agentId, trigger);
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];

    /** 用户是否按了中断。区分「用户停的」与「自己炸了」—— 两者呈现完全不同。 */
    let aborted = false;
    // **登记必须发生在第一次 await 之前。** 放在 `await runTurn(...)` 之后等于
    // 永远登记不上:WS 的每一条消息是各自 fire-and-forget 处理的,中断消息会在
    // 这个回合还卡在 await 里的时候就被处理掉。这正是「死接线」得以藏身的缝隙。
    inflight.set(pooledKey(projectId, agentId), () => {
      aborted = true;
      // `AgentSession.abort()` 是 async 且会等到 agent 真正 idle。这里**不 await**:
      // WS 的消息处理器不该被一次取消阻塞住。但失败要留现场(7-N),不许静默。
      void session.abort().catch((err: unknown) => {
        log.error(
          `platform: 中断${channelLabel(projectId)}上 ${agentId} 的回合失败:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });

    try {
      const turn = await runTurn({
        session,
        db,
        agentId,
        projectId,
        message: task,
        // ── 用量那两行接线(见 `RunTurnOptions.sessionId` 的已知缺口)───────
        //
        // `sessionId` 就在作用域里(`ensureSession` 刚算出来的那条),`runTurn`
        // 自己**不知道也不该猜**它(同一个项目里可以有多条会话,按
        // `(projectId, agentId)` 反推会得到一个「看起来对、换一个场景就错」的值)。
        //
        // `onUsageRecorded` 是实时推送的接缝 —— `runTurn` 不持有 WS 枢纽(它连
        // transport 都不该知道),所以推送必须由宿主接线。**不接的后果不是理论**:
        // `hub.emitUsageRecorded` 此前零调用方(有声明没读者),前端那条
        // `usage_recorded` 一个包都收不到。
        sessionId,
        onUsageRecorded: (row) => hub.emitUsageRecorded(row),
        // 墙钟上界透传。**不给默认值**:缺省由 `runTurn` 自己那份
        // `DEFAULT_WALL_CLOCK_TIMEOUT_MS` 兜底 —— 两个地方各写一个默认值,
        // 迟早会漂,而漂的表现是「文档说 10 分钟、实际是另一个数」。
        ...(opts.turnWallClockMs !== undefined
          ? { wallClockTimeoutMs: opts.turnWallClockMs }
          : {}),
        onEvent: (ev) => {
          bridge(ev, projectId, messageId, agentId, hub, textBuf, thinkBuf);
        },
      });
      // 助手消息落库(项目活过会话)。落的是**真正说话的那个 agent**,不是写死 bm。
      const text = turn.text.trim() !== "" ? turn.text : textBuf.join("");
      if (text.trim() !== "") {
        appendSessionMessage(db, {
          id: newId("m"), sessionId, agentId, kind: "assistant",
          content: text, createdAt: now(),
          // **封套:回合 + 这一轮的触发维度**(W3-①)。`trigger` 是本函数的
          // 形参、且是**必填**的 —— 它同时喂给 `hub.emitMessageStart`(实时)
          // 与这里(落库),所以「流式判据」与「刷新后的判据」不可能分叉:
          // 业务经理被待办叫醒的那一轮,两处都是 `todo` ⇒ 都不进甲方通道。
          //
          // ⚠️ **`todoKind` 必须一起落**(migration 022)。`CLIENT_FACING_TODO_KINDS`
          // 那三类(handover / report_downstream / resume_client)的正文**要**进甲方
          // 通道,而读面的判据读的就是这一列 —— 不落的后果与 W3-① 同形:流式看得见、
          // 刷新看不见,两条路给出不同答案。
          originSource: "turn", triggerKind: trigger.kind,
          todoKind: trigger.kind === "todo" ? trigger.todoKind : null,
        });
      }
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      if (aborted) {
        // 用户主动中断,但 SDK 的 prompt() 正常返回了(abort 让回合收敛)。
        // 已经拿到的正文照样落库 —— 中断不是丢弃,是「到此为止」。
        log.muted(
          `platform: ${channelLabel(projectId)}上 ${agentId} 的回合被用户中断` +
            `(已产出 ${text.length} 字符)`,
        );
      }
      if (turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: `${agentId} 的回合超时收尾,结果可能不完整` },
        });
      }
      // ── 回合收尾的检测(W2-③)────────────────────────────────────
      //
      // **只在这一支**(成功结束、且没被中断)跑。失败 / 被中断的回合**不消费**
      // `dispatch_events`(见 `dispatcher.ts` 的 `if (!aborted && !failed)`),
      // 证据还在、下一轮还会重来 —— 在那一支报警是**误报**。反过来,成功的
      // `report_downstream` 回合结束后那些事件立刻被标成「已交代」,而
      // 「这一回合留没留工作记录」是它们**唯一**的现场。
      if (!aborted) {
        reportUnannouncedTurn(projectId, agentId, messageId, trigger, text, turn.toolCalls);
      }
      return {
        aborted, timedOut: turn.timedOut, text, toolCalls: turn.toolCalls,
        openedProjectIds: turn.openedProjectIds, failed: false,
      };
    } catch (e) {
      // **中断不是故障。** 把一次「停止」报成 `turn_failed` 会让用户以为出了错,
      // 而他要的只是停下来。两条路径呈现不同,但都要收尾(前端还挂着流式气泡)。
      if (aborted) {
        log.muted(
          `platform: ${channelLabel(projectId)}上 ${agentId} 的回合被用户中断:` +
            `${e instanceof Error ? e.message : String(e)}`,
        );
        hub.emitMessageEnd(projectId, messageId);
        hub.emitAgentEnd(projectId);
      } else {
        hub.broadcast({
          type: "error", projectId,
          error: {
            code: "turn_failed",
            message: `${agentId}:${e instanceof Error ? e.message : String(e)}`,
          },
        });
        hub.emitAgentEnd(projectId);
      }
      return {
        aborted, timedOut: false, text: textBuf.join(""), toolCalls: [],
        openedProjectIds: [], failed: true,
        failureReason: e instanceof Error ? e.message : String(e),
      };
    } finally {
      inflight.delete(pooledKey(projectId, agentId));
    }
  }

  /**
   * 跑一个工作项(走现成的 `runWorkItem` —— 它自己拼 `composeWorkPrompt`)。
   *
   * 这条路与 `runAgentTurn` 分开是有意的:**工作项的「任务描述」由 BC6 决定,
   * 不由驱动者循环决定**。驱动循环只负责「谁该动、动哪一个」。
   */
  async function runWorkInSession(
    projectId: string,
    agentId: string,
    workId: string,
    trigger: TurnTrigger,
  ): Promise<DrainWorkReport> {
    const before = getWork(db, workId);
    const title = before?.title ?? workId;
    const got = await getOrCreateSession(projectId, agentId);
    if (!got.ok) {
      hub.broadcast({
        type: "error", projectId,
        error: { code: got.code, message: `${agentId}:${got.message}` },
      });
      return {
        workId, title, status: before?.status ?? "open",
        aborted: false, timedOut: false, text: "", toolCalls: [],
        failed: true,
        detail: `${got.code}:${got.message}`,
      };
    }
    const session = got.session;
    // **通道 = `internal`(调用点显式声明)**:工作项执行是**内部**流水线,不是
    // 甲方对话。这一条正是 C4 的回归判据 —— 交付对话建出来之后,worker 的产出
    // **不得**落进那场交付的对话里(设计 1 §2.11.6)。
    const sessionId = ensureSession(db, projectId, now(), newId, "internal");
    const messageId = newId("msg");
    // 执行那条路的说话人是 `agentId`(worker,或派活的角色)—— 不是写死的 bm:
    // 它由 `drainOne` 的 `runWork` 回调按待办把 agent 传进来。`trigger` 同理:
    // 这一支**只**可能由 `execute_work` 待办触发,而那个值仍然是**从 `todo.kind`
    // 传下来的真值**(不是这里写的字面量)—— 见 `dispatcher.ts` 的 `DrainDeps.runWork`。
    hub.emitMessageStart(projectId, messageId, "assistant", agentId, trigger);
    const textBuf: string[] = [];
    const thinkBuf: string[] = [];
    let aborted = false;
    inflight.set(pooledKey(projectId, agentId), () => {
      aborted = true;
      void session.abort().catch((err: unknown) => {
        log.error(
          `platform: 中断${channelLabel(projectId)}上 ${agentId} 的执行失败:` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    });
    try {
      const execution = await runWorkItem({
        session, db, workId,
        // 与 `runAgentTurn` 那两行同一条理由、同一批接线:执行这条路上的回合
        // 同样要落 `turn_usage.session_id` 并把 `usage_recorded` 推给前端。
        // **两条路都要接** —— 只接聊天那条等于没接(与墙钟上界同一条教训,
        // 真机现场那个跑了 16 分钟的 worker 回合走的正是这里)。
        sessionId,
        onUsageRecorded: (row) => hub.emitUsageRecorded(row),
        ...(opts.turnTimeoutMs !== undefined ? { timeoutMs: opts.turnTimeoutMs } : {}),
        // 同一根线也要接在**执行**这条路上:worker 卡在 curl 文档 16 分钟那次
        // 真机现场走的正是这里,只接 `runAgentTurn` 等于没接。
        ...(opts.turnWallClockMs !== undefined
          ? { wallClockTimeoutMs: opts.turnWallClockMs }
          : {}),
        // 让 worker 这一回合也流式上屏 —— 否则它在界面上是一段没有反应的等待
        onEvent: (ev) => {
          bridge(ev, projectId, messageId, agentId, hub, textBuf, thinkBuf);
        },
      });
      // ⚠️ **这里刻意不读 `execution.producedArtifacts`**(B3 的裁决:它是**报告**,
      // 不是**触发**。完整的证据链在那个字段的注释里,判据的机器形式在
      // `tests/platform/b3-produced-artifacts.test.ts`)。
      //
      // 一句话:产出边只有 `board_write` 会写,而它本就在门铃清单里 —— 本回合的门铃
      // **已经响过**;而 `drainProject` 每一回合都重新查库(`collectTodos` 的输入里
      // 根本没有工件),所以拿它当布尔再敲一次铃查到的是同一份待办。要「被工件推动」,
      // 加的是 `RULES` 的纯查询判据,不是这里的一个布尔。
      const text = execution.turn.text.trim() !== ""
        ? execution.turn.text
        : textBuf.join("");
      if (text.trim() !== "") {
        appendSessionMessage(db, {
          id: newId("m"), sessionId, agentId, kind: "assistant",
          content: text, createdAt: now(),
          // **封套:回合 + 触发维度**(W3-①)。执行这一条路(worker / 质检 /
          // 整合)今天全都是 `todo` 触发的 —— 正文是组织内部在动,不该进对话页;
          // 但它**照实落库**,而不是在这里写死:判据留在读侧一处
          // (`messageOriginOf` + `channelOf`),将来多一条触发维度时不用改这里。
          // ⚠️ `todoKind` 同样落(migration 022),否则读面分不清是哪一类待办 ——
          // 分不清就一律按「内部」处理,那对业务经理的 `close_project` 之类是对的,
          // 但对将来任何「这一类要对甲方说」的待办都是错的。
          originSource: "turn", triggerKind: trigger.kind,
          todoKind: trigger.kind === "todo" ? trigger.todoKind : null,
        });
      }
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      if (execution.work.status !== before?.status) {
        hub.emitWorkChanged(projectId, workId, execution.work.status);
      }
      if (execution.turn.timedOut) {
        hub.broadcast({
          type: "error", projectId,
          error: { code: "turn_timeout", message: `工作项 ${workId} 的回合超时收尾` },
        });
      }
      // ── 拒绝执行 ≠ 成功(2026-10-05 补)────────────────────────────
      //
      // `runWorkItem` 的 `checkRunnable` 会拒绝三类工作项(已是终态 / 负责人不存在 /
      // 负责人不是 worker),那时它**没调模型**、返回 `outcome: "refused"`。
      // 这个返回值此前被整段忽略 ⇒ 一个什么都没做的派发被 dispatcher 当成
      // **成功**(`failed` 缺席),于是:①它的空转被记进「N 个回合」;②`!aborted &&
      // !failed` 那一支会替它走平台记账(今天 `execute_work` 恰好没有记账动作,
      // 但那是「今天恰好」)。现在如实报 `failed` + `refused`,理由一起带出去。
      const refused = execution.outcome === "refused";
      return {
        workId,
        title: execution.work.title,
        status: execution.work.status,
        aborted,
        timedOut: execution.turn.timedOut,
        text,
        toolCalls: execution.turn.toolCalls,
        failed: refused,
        ...(refused ? { refused: true } : {}),
        ...(refused
          ? { detail: execution.refusalReason ?? `工作项 ${workId} 被拒绝执行` }
          : {}),
      };
    } catch (e) {
      hub.broadcast({
        type: "error", projectId,
        error: {
          code: "work_failed",
          message: `执行 ${workId} 时抛错:${e instanceof Error ? e.message : String(e)}`,
        },
      });
      hub.emitMessageEnd(projectId, messageId);
      hub.emitAgentEnd(projectId);
      return {
        workId, title, status: getWork(db, workId)?.status ?? before?.status ?? "open",
        aborted, timedOut: false, text: textBuf.join(""), toolCalls: [],
        failed: true,
        detail: e instanceof Error ? e.message : String(e),
      };
    } finally {
      inflight.delete(pooledKey(projectId, agentId));
    }
  }

  // ── 排空器接线(判定在 runtime/dispatcher.ts)─────────────────
  //
  // 这里**只有接线**:两个触发点(门铃 / 定时器)都不携带状态,判定与排空
  // 全在 `drainProject`。宿主**不再持有任何跨排空的状态** —— 批次 20 的
  // `stallStore` 与 `cascadeStates` 整块消失:它们要挡的两件事(「同一个待办
  // 被反复叫醒」与「撞上界时下游结果不丢」)现在分别由库里的尝试预算
  // (`dispatch_attempts`)与 outbox(`dispatch_events`)承担。
  //
  // ── 并发模型(D1–D3):**并行只在项目之间** ──────────────────────
  //
  //   ① `drainingProjects`(每项目一个闩)—— 取代原先后宿主级的 `draining`。
  //      原来那个闩的唯一理由是防**叠**:「一次排空可能比定时器间隔还长,
  //      不加闩就会叠起来跑(而每一层都在花 token)」。而「叠」这件事的判据是
  //      **(项目, 排空)** 而不是 **(排空)**:同一个项目叠起来才会重复花 token
  //      (`drainOne` 的让路判据 + 忙闩也挡着那一半),不同项目叠起来恰恰是
  //      这次要的效果。
  //      宿主级闩还有一个它自己看不见的副作用:它把「全局同时只有一个项目在跑」
  //      变成了事实上的第二道上界 —— 拆它的时候必须同时把上界**显式**建出来,
  //      那就是 ②。
  //   ② `projectSlots`(全局信号量,上限 `maxConcurrentProjects`,默认 3)——
  //      唯一限制「全局同时在烧多少 token」的东西(**硬上界**,见 ServeOptions)。
  //   ③ `nudgedProjects`(每项目一个打点)—— 取代原先后宿主级的 `nudgedWhileBusy`。
  //
  // ⚠️ 形状上为什么不选「外层留一个 pass 闩 + pass 内并行」:那样**做不到 D3**。
  //    pass 内并行意味着所有项目要在一个 barrier 处汇合,于是「A 排空期间 B 敲门」
  //    只能等 A 那一整次排空跑完才被处理 —— 而 A 的一次排空可以跑几分钟
  //    (真机现场:一个 worker 回合 16 分钟)。要「B 立刻被处理」,B 的排空就必须
  //    是**独立的一条循环**,只受 ② 的上界约束,不等别人。
  //    代价是「两趟 pass 会重复扫一遍项目列表」—— 那不是 token,是几条 SQL:
  //    没有待办的项目在 `drainProject` 里查一次就退,一个回合都不跑。
  //
  // ⚠️⚠️ **项目内部现在真的会并发**(用户找业务经理 ⊥ 排空叫醒 worker / 质检 /
  //    项目经理)—— 忙闩的键从「项目」改成「`(项目, agent)`」之后,这一条从
  //    「不可达」变成「可达」。R1 读出来过两条雷,两条都已处置:
  //
  //    (a) `getOrCreateSession` 是 **check-then-act**(`sessions.get` →
  //        `await createPlatformSession` → `sessions.set`)⇒ 同一个
  //        `(上下文, agent)` 并发进入,两边都读到 `undefined`,于是建出**两条**
  //        会话,后一次 `set` 覆盖前一条;而被覆盖的那条**永远不会被
  //        `disposeSessionsFor` 回收** —— 泄漏一条带订阅的常驻会话。
  //        ✅ **由忙闩本身关掉**:`(上下文, agent)` 的闩在**建会话之前**占用、
  //        在回合收尾之后释放,而两条路(`handleUserMessage` 的同步占用 /
  //        排空的 `withTurnLatch`)都必须先拿到它 ⇒ 同一个键的两个
  //        `getOrCreateSession` 在结构上不可能同时在飞。
  //        **键与池子的键同粒度才是这条性质的来源**(按项目记的闩挡不住
  //        「同项目两个角色各自建会话」—— 那两条本来就该并发)。
  //    (b) `inflight` 的键原来是 `projectId | null`,**不是** `(projectId, agentId)`:
  //        同一个项目里两个角色并发时,后者的中断登记覆盖前者 ⇒ 用户的
  //        「中断」只到得了最后一个回合。
  //        ✅ 已改键(`pooledKey`),`onInterrupt` 也随之改成「停掉这个上下文里
  //        正在跑的**每一个**」(协议里只有 projectId,见那里的注视)。
  //
  //    下面这三条宿主级结构与它们无关(不要顺手一起改):
  //    `drainingProjects` / `nudgedProjects` / `projectSlots` 管的是**排空之间**
  //    的重叠与全局上界,不是「一个回合」。排空**内部**仍然是逐回合串行的
  //    (`drainProject` 一条一条 await),所以「一个项目里同时跑的排空回合数」
  //    永远是 0 或 1。

  /**
   * 合并唤醒的两个旋钮 —— **同一份**给排空(下面的 `drainProject`)与读面
   * (`GET /api/projects/:id/live`)用。
   *
   * 为什么必须共用:读面要如实回答「排空器**现在**会不会叫醒它」,而那个答案
   * 依赖这两个阈值。各写一份的后果是具体的 —— 用户用 `--report-batch-size 10`
   * 起了服务,页面却按缺省的 3 条显示「它现在就该跑」,于是界面开始**自信地
   * 说一个排空器不会做的动作**。
   *
   * 仍然**不给默认值**:缺省在 `collectTodos` 里(`DEFAULT_REPORT_BATCH_SIZE` /
   * `DEFAULT_REPORT_MAX_DELAY_MS`),两处各写一份迟早会漂。
   */
  const collectOptions: LiveCollectOptions = {
    ...(opts.reportBatchSize !== undefined ? { reportBatchSize: opts.reportBatchSize } : {}),
    ...(opts.reportMaxDelayMs !== undefined ? { reportMaxDelayMs: opts.reportMaxDelayMs } : {}),
  };

  /**
   * 排空兜底周期。**算一次,两处用**(建定时器 + 读面报它的 `intervalMs`)——
   * 各写一遍的话,改了命令行参数之后页面显示的还是缺省的 10s。
   */
  const dispatchIntervalMs = opts.dispatchIntervalMs ?? DEFAULT_DISPATCH_INTERVAL_MS;

  /** 每个项目一个排空闩:**同一个项目**的排空永不重叠(不同项目互不阻塞)。 */
  const drainingProjects = new Set<string>();
  /** 每个项目一个打点:排空期间有人敲过门 → 那一趟跑完再查一遍。 */
  const nudgedProjects = new Set<string>();
  /** 全局并发上限(硬上界,见 ServeOptions.maxConcurrentProjects)。 */
  const projectSlots = createSemaphore(
    Math.max(1, opts.maxConcurrentProjects ?? DEFAULT_MAX_CONCURRENT_PROJECTS),
  );

  /**
   * 门铃:状态迁移后敲一下。**不携带任何状态**,只说「现在去查一下」。
   *
   * `projectId` 给了就只排那一个;不给 = **扫全部活跃项目**。
   * 无参那条路今天只有**一个**调用点(见 `handleUserMessage` 末尾):项目内也能
   * 用 `project.open` 立起**别的**项目,那是唯一「一次状态迁移影响到别的项目」的
   * 场合 —— 旧实现(门铃一律扫全部)会顺手把新项目捡起来,按项目敲之后要显式补。
   * 定时器那条路不走这里,它自己调 `drainAll("timer")`。
   *
   * **按项目敲是要紧的**:宿主级那个单一打点(`nudgedWhileBusy`)会让
   * 「A 排空期间 B 敲门」被吞掉 —— 不是因为它记不住,而是因为「故意停下
   * (`max_rounds` / 预算用尽)就不再重跑」这条防叠判据原来是**全局**的:
   * 只要任何一个项目故意停下,B 的敲门就一起被丢掉(B 要等下一个 10s tick)。
   * 现在这条判据随项目走,一个项目停它的,B 照跑。
   */
  function nudge(projectId?: string): void {
    const run =
      projectId !== undefined
        ? drainProjectLoop(projectId)
        : drainAll("nudge");
    void run.catch((err: unknown) => {
      log.error(`platform: 排空失败 —— ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  /**
   * **一个项目**的排空循环:拿到许可 → 查到没有待办为止 → 期间被敲过门再来一遍。
   *
   * 幂等:同一个项目已有排空者在跑时只记一次打点,不排第二条(那才是「叠」)。
   * 已停下(**故意**撞上界 / 预算用尽)的项目**不因门铃重跑** —— 该等下一次
   * 定时器,那是它存在的理由(兜底),而不是把上界让给门铃。这条判据是**按项目**
   * 的(D3 的洞正是它原来为全局)。
   */
  function drainProjectLoop(projectId: string): Promise<DrainResult | null> {
    if (drainingProjects.has(projectId)) {
      nudgedProjects.add(projectId);
      return Promise.resolve(null);
    }
    drainingProjects.add(projectId);
    return runProjectDrain(projectId).finally(() => {
      drainingProjects.delete(projectId);
      // ⚠️ **这里刻意不删 `nudgedProjects` 里的这一项。** 它看起来像一次漏掉的
      // 清理,删了就会重新造出 D3 的洞:门铃可能恰好在「循环判完条件、闩还没放开」
      // 的那个缝里响,而它记下的正是这一项 —— 删掉 = 那次敲门被吞。留着是安全的:
      // 下一次进这个循环的第一件事就是清它。
    });
  }

  async function runProjectDrain(projectId: string): Promise<DrainResult | null> {
    // 许可在**循环外**拿一次:这一整个项目在这段时间里都在烧 token,中途放掉
    // 会让第 4 个项目插进来,而上界就不再是上界。
    const release = await projectSlots.acquire();
    try {
      let last: DrainResult | null = null;
      let deliberateStop = false;
      do {
        // 先清打点再查库:这一趟之后**新**响的门铃才会让循环再跑一遍。
        nudgedProjects.delete(projectId);
        last = await drainOne(projectId);
        if (last !== null && (last.stopReason === "max_rounds" || last.stopReason === "no_progress")) {
          deliberateStop = true;
        }
      } while (!deliberateStop && nudgedProjects.has(projectId));
      return last;
    } finally {
      release();
    }
  }

  /**
   * 扫一遍**全部活跃项目**(定时器兜底,以及判不出来源的门铃)。
   *
   * `source` 只用于**留痕**(门铃 / 定时器)—— 两个触发点的行为完全一样,
   * 判定与排空都不因它改变。没有这一行,事后就无法回答「这一步是谁触发的」,
   * 而「哪条路径在工作」正是这次重构最需要能看见的事(7-N:见不到的现场等于没有现场)。
   *
   * ⚠️ **一条待办都没跑的时候不打日志。** 定时器是 10 秒一次,而绝大多数 tick
   * 都是「没有待办」—— 每次都打一行「排空开始/结束」会在几小时里刷满日志,
   * 把真正有信息量的行淹掉(与超时扫描「只在集合变化时广播」同一条理由)。
   * 有回合数才留痕:`排空收尾(触发=… · N 回合 · 路径 …)`。
   *
   * **它 await 自己启动的那些循环** —— `startFixedDelay` 靠这个保住
   * 「上一轮跑完再等 10s」的语义(它自己也 await `run()`)。已经在跑的
   * (门铃先起的)项目返回 `null`,不由这一趟负责。
   */
  async function drainAll(source: "nudge" | "timer"): Promise<void> {
    const ids = listProjects(db, "active").map((p) => p.id);
    // 一个项目炸了不该拖停这一趟的其它项目 —— 逐项收口,并且**响亮**(7-N)。
    const results = await Promise.all(
      ids.map(async (id) => {
        try {
          return await drainProjectLoop(id);
        } catch (err) {
          log.error(
            `platform: 项目 ${id} 排空失败 —— ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }
      }),
    );
    const ran = results.filter((r): r is DrainResult => r !== null);
    const rounds = ran.reduce((n, r) => n + r.rounds, 0);
    const path = ran.flatMap((r) => r.visited.map((v) => v.agentId));
    if (rounds > 0) {
      log.muted(
        `platform: 排空收尾(触发=${source} · ${ids.length} 个项目 · ${rounds} 回合` +
          (path.length > 0 ? ` · 路径 ${path.join("→")}` : "") +
          ")",
      );
    }
  }

  /**
   * 排空一个项目。返回它的结果(`null` = 因为甲方正在跟业务经理说话而让开)。
   *
   * ── 闩的粒度(这次改的就是它)──────────────────────────────────
   *
   * 旧写法在**整趟排空**期间占着 `hub.setBusy(projectId)`,于是一次级联
   * (真机 18 分钟、最多 8 个回合)里甲方**发不出话** —— 而排空跑的常常是
   * worker / 质检 / 项目经理,与他要找的业务经理**不是同一条会话**。
   *
   * 现在:① 这里只做一次**让路判据**(甲方正在跟业务经理说话 ⇒ 这一趟让开,
   * 他那边回合结束时会自己敲门);② 每个回合由 `withTurnLatch` **单独**占用
   * 它自己那个角色的会话(排空里不同回合是不同 agent)。
   * `maxConcurrentProjects` 信号量是**另一层**(全局上界),一点都不动。
   */
  async function drainOne(projectId: string): Promise<DrainResult | null> {
    // **重入闩的一半**:甲方正与业务经理对话时,排空让开(那条路结束时会自己
    // 敲门)。判据是**那个角色**,不是整个项目 —— 项目里 worker 在跑不该挡住
    // 甲方找业务经理,反过来也一样。另一半是 `drainingProjects`(按项目)。
    const talker = clientFacingAgentId(db);
    if (talker !== null && hub.isBusy(projectId, talker)) {
      log.muted(`platform: ${channelLabel(projectId)}的业务经理正在跟甲方说话,跳过本次排空`);
      return null;
    }
    /** 这一轮排空被用户中断过 —— 传进 dispatcher 让它立刻停 */
    let cancelled = false;
    // ⚠️ 这里**没有** `hub.setBusy(projectId, …)`,也**没有** `inflight.delete(projectId)`:
    // 整趟排空不再占闩(每个回合的闩由 `withTurnLatch` 自己持/放),而 `inflight`
    // 按 `(上下文, agent)` 记 —— 在上下文这一层删会抹掉别的角色的登记。
    const result = await drainProject({
      db,
      projectId,
      now,
      log: (l) => log.muted(l),
      ...(opts.maxCascadeRounds !== undefined ? { maxRounds: opts.maxCascadeRounds } : {}),
      // 合并唤醒的两个旋钮。**与读面共用同一份 `collectOptions` 对象** ——
      // 各写一份的后果见那里的注释(界面会按缺省阈值说一个排空器不会做的动作)。
      // 也仍然**不给默认值**:缺省在 `collectTodos` 里
      // (`DEFAULT_REPORT_BATCH_SIZE` / `DEFAULT_REPORT_MAX_DELAY_MS`)。
      ...collectOptions,
      isCancelled: () => cancelled,
      // `todoKind` 是 `drainProject` 传下来的**真值**(`todo.kind`)。宿主在这里
      // 把它翻成契约的 `trigger` —— 这是「runtime 的待办种类」跨到「回合为什么
      // 存在」的**唯一**一处接缝:`runAgentTurn` 不可能自己知道,因为它拿到的
      // 只是 `(agentId, task)`。
      runAgentTurn: async (agentId, task, todoKind): Promise<DrainTurnReport> => {
        return withTurnLatch(projectId, agentId, { kind: "todo", todoKind }, async () => {
          const r = await runAgentTurn(projectId, agentId, task, { kind: "todo", todoKind });
          if (r.aborted) cancelled = true;
          return {
            aborted: r.aborted, timedOut: r.timedOut, text: r.text, toolCalls: r.toolCalls,
            failed: r.failed,
            ...(r.failureReason !== undefined ? { detail: r.failureReason } : {}),
          };
        });
      },
      runWork: async (agentId, workId, todoKind): Promise<DrainWorkReport> => {
        return withTurnLatch(projectId, agentId, { kind: "todo", todoKind }, async () => {
          const r = await runWorkInSession(projectId, agentId, workId, { kind: "todo", todoKind });
          if (r.aborted) cancelled = true;
          return r;
        });
      },
    });
    announceDrain(projectId, result);
    return result;
  }

  /**
   * **一个回合的闩**:排空器每条回合单独占用它那个角色的常驻会话。
   *
   * ── 为什么是「每回合」而不是「整趟排空占着项目」────────────────────
   *
   * 排空里不同回合是**不同 agent**(项目经理拆解 → worker 执行 → 质检 → 业务
   * 经理汇报),而受保护的资源是**每个角色自己那条常驻会话**。整趟占着项目 =
   * 甲方在整个级联(真机 18 分钟)里发不出话,而他要找的人与正在跑的人不是同一个。
   *
   * ── 为什么是「等」而不是「跳过这一回合」───────────────────────────
   *
   * 排空器**按回合记账**(`dispatch_attempts`,默认 3 次):跳过一回合会被记成
   * 「叫醒过一次却没动」,三次就把那条待办的预算烧光,然后广播一条**假的**
   * `cascade_stopped` + 落一条 system 消息。等它空出来,这一回合就真的跑了 ——
   * 代价只是这一趟排空多花一点墙钟,而它本来就在等回合。
   *
   * ⚠️ 排队**不影响全局上界**:`projectSlots` 是外层信号量,这里等的是**同一个
   * 项目内部**那把闩,不会多占许可(它本来就在这个许可里)。
   *
   * `trigger` 是**这一轮为什么存在**(`{kind:"todo", todoKind}`)。它随闩一起
   * 登记进枢纽(`hub.acquireTurn`)—— 成员页的「正在做什么」要显示「被哪条待办
   * 叫醒」,而那个值只有调用点知道(`todoKind` 是 `drainProject` 传下来的真值,
   * 不是这里猜的)。
   */
  function withTurnLatch<T>(
    projectId: string,
    agentId: string,
    trigger: TurnTrigger,
    fn: () => Promise<T>,
  ): Promise<T> {
    return hub.acquireTurn(projectId, agentId, trigger).then(async (release) => {
      try {
        return await fn();
      } finally {
        release();
      }
    });
  }

  /**
   * **工件触发的回合没留工作记录**时,落一条平台自己的告警(W2-③)。
   *
   * 判据在 `detectUnannouncedTurn`(**纯函数**,导出给测试)。这里只负责**产物**:
   *
   *   ① 平台日志(`log.warn`)—— 可 grep、可计数,运维看得见;
   *   ② 一条 `system` 会话消息(通道 `internal`,**落库**)—— 「计数」的可见形态:
   *      它就是一行可 `SELECT COUNT(*)` 的记录,而且用户在工作记录里看得见。
   *      与 `announceDrain` 的 `cascade_stopped` 同形:平台检测到的异常,
   *      不是任何一个角色对甲方说的话。
   *
   * ⚠️ **产物里没有、也不会有 `[未播报]` 那一行。** 平台**不替模型写工作记录**:
   * 补写的字会被后来的读者当成「业务经理当时判断过了」—— 那是**编造现场**,
   * 比没有现场更坏(7-N 要的是「事后看得出当时发生了什么」,不是「事后看起来
   * 一切都合规」)。
   *
   * ⚠️ 告警正文里刻意**不让任何行以 `[未播报]` 开头**:那行字本身带方括号标记
   * 的语义,一旦落在行首会被前端 `splitWorkLog` 当成工作记录块 —— 平台告警
   * 不该长成一个「业务经理的判断」。
   */
  function reportUnannouncedTurn(
    projectId: string | null,
    agentId: string,
    messageId: string,
    trigger: TurnTrigger,
    text: string,
    toolCalls: readonly ToolCallRecord[],
  ): void {
    // 判据 ② 的**真读**:项目级未消费条数。⚠️ 它**不进判据**,只作为现场 ——
    // 理由(「本回合属于哪条事件」库里不存在)见 `detectUnannouncedTurn` 上方。
    const pendingEventCount =
      projectId === null ? 0 : listPendingDispatchEvents(db, projectId).length;
    // `channel` 用**与建会话同一个判据**(`channelForAgent`):这条规矩只写给
    // 对甲方说话的那个角色(今天 = 业务经理)。见 `detectUnannouncedTurn` 的说明。
    const hit = detectUnannouncedTurn({
      trigger, channel: channelForAgent(db, agentId), text, toolCalls, pendingEventCount,
    });
    if (hit === null) return;
    const where = `${channelLabel(projectId)} · ${agentId} · 回合 ${messageId}`;
    const facts =
      `待办类别 ${hit.todoKind};成功投递的 tell_client 0 次(共调用 ${hit.tellClientCalls} 次);` +
      `收尾时项目级未消费事件 ${hit.pendingEventCount} 条`;
    log.warn(
      `platform: ⚠️ 平台叫醒的回合没留工作记录 —— ${where}(${facts})。` +
        `正文前 ${UNANNOUNCED_TEXT_HEAD_CHARS} 字:${JSON.stringify(hit.textHead)}`,
    );
    if (projectId === null) return;
    const sessionId = ensureSession(db, projectId, now(), newId, "internal");
    appendSessionMessage(db, {
      id: newId("m"),
      sessionId,
      agentId: null,
      kind: "system",
      content:
        `⚠️ 平台检测:平台叫醒的回合没留工作记录(未调 tell_client,正文也没有行首标记)\n` +
        `${where}\n${facts}\n正文前 ${UNANNOUNCED_TEXT_HEAD_CHARS} 字:${hit.textHead}`,
      createdAt: now(),
      // **不属于任何封套**:平台通知不是回合、不是播报。读侧给
      // `{ source: "unknown" }`,而前端第 1 步就按 `kind='system'` 把它摘进
      // 系统带(与「封套没到」互不影响)。
      originSource: null, triggerKind: null,
    });
  }

  /**
   * 排空停下来之后**如实告诉用户它是怎么停的**。
   *
   * ⚠️ 异常停止(`max_rounds` / 预算用尽)**不能静默** —— 界面会回到 idle,
   * 而用户会以为「还在跑」或「已经做完了」。两种误解都会让他在错误的时刻做决定。
   * 所以做两件事:广播一条 `cascade_stopped`(前端立刻看见)+ 落一条 `system`
   * 会话消息(刷新之后还在)。正常的 `exhausted` / `cancelled` 不打扰他。
   *
   * 「预算用尽」只在**第一次**用尽时播报(`newlyExhausted`)—— 否则每 10 秒一条
   * system 消息,那也是一种静默。
   *
   * ── 2026-10-05:文案里的「N 个回合」是假的,现在报**两个数** ─────────
   *
   * 真机那条写着「已达单次排空上限 8 个 agent 回合」,而 8 次派发里只有 2 个真回合
   * (其余 6 次 33 ms 内返回、没叫醒任何 agent —— 见 `DispatchOutcome`)。
   * 所以:①标题与正文都写「N 次派发 · 其中 M 个真回合」;②把**空转的那几次**
   * 逐条列出来(谁、哪条待办、为什么没跑起来)—— 那是「预算花在哪了」的答案,
   * 而它正是用户看到这条告警时第一个会问的问题。折叠不静默:超出上限的折成一行计数。
   */
  function announceDrain(projectId: string, r: DrainResult): void {
    const who = r.visited.map((v) => v.agentId).join(" → ");
    // `turns` 与 `rounds` 并列出现的地方必须都带上「派发/真回合」这两个词,
    // 否则读者会把 `rounds` 当成回合数(那正是这条告警此前的错)。
    const spread = `${r.rounds} 次派发 · 其中 ${r.turns} 个真回合`;
    const idleLines = formatIdleTrail(r.visited);
    const idleBlock =
      idleLines.length > 0
        ? `\n派发了但没跑起来的 ${r.rounds - r.turns} 次:\n${idleLines.join("\n")}`
        : "";
    const reason = r.stopReason;
    const reportable =
      reason === "max_rounds" || (reason === "no_progress" && r.newlyExhausted.length > 0);
    // 什么都没跑的安静停(没有待办 / 已经报过的预算用尽)不刷日志 ——
    // 每 10 秒一行「排空结束」会把真正有信息量的行淹掉
    if (r.rounds === 0 && !reportable) return;
    log.muted(
      `platform: ${channelLabel(projectId)}排空结束 —— ${spread},` +
        `停止原因 ${reason}(${r.stopDetail})` +
        (who !== "" ? `\n        路径:${who}` : "") +
        idleBlock,
    );
    if (!reportable) return;
    hub.broadcast({
      type: "cascade_stopped",
      projectId,
      rounds: r.rounds,
      turns: r.turns,
      reason,
      detail: r.stopDetail,
    });
    // **通道 = `internal`(调用点显式声明)**:平台通知不是任何一个角色对甲方
    // 说的话 —— 它是机器的记录。前端把它渲染成 `system` 带(`agentId === null`
    // 且 `kind === 'system'`),不落进任何人的气泡。
    const sessionId = ensureSession(db, projectId, now(), newId, "internal");
    appendSessionMessage(db, {
      id: newId("m"),
      sessionId,
      agentId: null,
      kind: "system",
      content:
        `⚠️ 组织停止推进(${spread}):${r.stopDetail}` +
        (who !== "" ? `\n本轮路径:${who}` : "") +
        idleBlock,
      createdAt: now(),
      // 同上一处:平台通知不属于任何封套(见 `reportUnannouncedTurn`)。
      originSource: null, triggerKind: null,
    });
  }

  // ── HTTP ──────────────────────────────────────────────────────

  const app = createPlatformApp({
    db,
    dataDir: opts.dataDir,
    cwd,
    personaName: booted.settings.personaName,
    version: opts.version,
    modelId: booted.provider?.modelId ?? null,
    provider: booted.provider?.provider ?? null,
    hasAnyProvider: booted.provider !== null,
    now,
    newId,
    /**
     * 运行期快照(只读)—— 三个**内存**读点,外加排空的旋钮。
     *
     * `dispatchTimer` 在本函数里**声明在后面**:这里的三个 `() => …` 都是
     * 惰性闭包(HTTP 处理器调用时才求值),而那时定时器早已建好。写成直接求值
     * (`dispatch: () => ({ lastRunAt: dispatchTimer.lastRunAt() })` 之外的任何
     * 提前取值)会在启动时撞上 TDZ —— 这正是把它写成函数的原因。
     */
    live: {
      turns: () => hub.runningTurns(),
      dispatch: () => ({
        intervalMs: dispatchIntervalMs,
        lastRunAt: dispatchTimer.lastRunAt(),
      }),
      drainingProjects: () => [...drainingProjects],
      collect: collectOptions,
    },
    settings: {
      // 每次都重新 load —— store 内部有缓存,但语义上要表达「读的是当前值」
      read: () => toPublicSettings(booted.settingsStore.load()),
      write: async (body) => {
        const r = applySettingsPatch(booted.settingsStore, body);
        if (!r.ok) return { ok: false as const, error: r.error };
        // **写成功之后必须重新解析模型** —— 用户改 provider 之后,
        // 下一次建会话要用新的那个;沿用 boot 时解析的会一直用旧模型。
        await reResolveModel();
        // 已建的常驻会话带着旧模型,必须丢掉重建
        disposeAllSessions("设置变更 —— 下次对话用新模型重建");
        return { ok: true as const, settings: toPublicSettings(r.settings) };
      },
      providers: () => listProviders(),
    },
    harnessDirs: {
      dataDir: opts.dataDir,
      // 出厂副本:`dist/src/platform/host/` 上三级是 `dist/`,再进 `harness/system_prompts/`
      // (构建时由 package.json 的 build:server 从仓库 harness/ 拷过去)
      factoryDir: resolve(HERE, "../../../harness/system_prompts"),
    },
    reset: () => {
      // 常驻会话必须丢掉:它们绑着已被删掉的项目,继续用会往空项目里写消息
      disposeAllSessions("数据重置");
      // ⚠️ 这里**没有**任何排空器状态要清 —— 那是这次重构的要点:
      // 判定与状态全在库里(works.review_state / dispatch_events /
      // dispatch_attempts 都是平台表,由 `resetPlatformData` 一起清),
      // 进程内存里一份都不留。批次 20 在这里清 `cascadeStates` 与 `stallStore`
      // 的那两行,正是因为当时状态漏进了内存。
      const report = resetPlatformData(db);
      log.ok(`platform: 数据已重置,清空 ${report.totalRows} 行(${report.cleared.length} 张表)`);
      return report;
    },
  });

  // 静态前端:生产构建产物。**放在所有 API 路由之后**注册,
  // 否则 serveStatic 的 `/*` 会把 API 请求也吞掉。
  // HERE = dist/src/platform/host/ → 上三级是 dist/ → 再进 web
  // (第一版写成 "../../../dist/web",算出来是 dist/dist/web,于是前端永远"找不到")
  const webRoot = resolve(HERE, "../../../web");
  if (existsSync(webRoot)) {
    const staticApp = serveStatic({ root: webRoot });
    app.use("/*", staticApp);
    log.muted(`platform: 托管前端 ${webRoot}`);
  } else {
    log.warn(`platform: 没找到前端产物(${webRoot})—— 先跑 npm run build:web`);
  }

  // ── 两个周期入口(职责不同,分开)─────────────────────────────
  //
  //   ① 调度器(60s):扫超时提问并推给前端。**不自动升级** —— 经 jev 校准,
  //      单人本地服务里「人暂时没回」是常态而不是故障(见 scheduler.ts 文件头)。
  //   ② 排空定时器(**fixed-delay,默认 10s**):排空器的兜底触发 ——
  //      重启恢复、事件漏掉的、以及外部直接改库的场合。
  //
  // 为什么分成两条而不是继续挂在调度器上:两条周期的**语义**不同。超时扫描是
  // 「每 60 秒看一眼有没有人没回」,而排空是「有活就干、没活就什么都不做」的
  // 兜底 —— 它们的合理间隔差一个数量级(10s vs 60s),合成一条必然要迁就其中
  // 一个。fixed-delay(上一轮跑完再等 10s)还顺带保证了两轮排空不重叠。
  const scheduler: Scheduler = startScheduler({
    db,
    now,
    broadcast: (ev) => hub.broadcast(ev),
    log: (l) => log.muted(l),
    ...(opts.schedulerIntervalMs !== undefined
      ? { intervalMs: opts.schedulerIntervalMs }
      : {}),
  });

  const dispatchTimer: FixedDelayLoop = startFixedDelay({
    intervalMs: dispatchIntervalMs,
    run: () => drainAll("timer"),
    log: (l) => log.error(l),
  });

  return {
    app,
    hub,
    booted,
    scheduler,
    dispatchTimer,
    sessionCount: () => sessions.size,
    close: () => {
      scheduler.stop();
      dispatchTimer.stop();
      disposeAllSessions("服务关闭");
      booted.close();
    },
  };
}

/** 排空定时器的默认间隔:**fixed-delay 10 秒**(上一轮跑完再等 10 秒)。 */
const DEFAULT_DISPATCH_INTERVAL_MS = 10_000;

/**
 * **同时排空几个项目**的默认值。
 *
 * 取 3 的理由(用户拍板,这里记下它为什么是个合理的数):并发之后
 * `maxCascadeRounds` / `dispatch_attempts` / `turnWallClockMs` **全部按项目记**,
 * 没有任何一条约束「全局同时在烧多少 token」—— 于是并发项目数就是那个代理指标,
 * 它必须是一个**硬**上界。3 是「大多数机器上真能并行(每个回合都在等网络 I/O)、
 * 又不会让一次用户消息引爆 N 倍花费」的那个数;它可配,而不是从代码里拿掉。
 */
const DEFAULT_MAX_CONCURRENT_PROJECTS = 3;

/**
 * 计数信号量(**FIFO**,释放幂等)。
 *
 * 为什么是信号量而不是「`Promise.all` + 分批」:分批的语义是「每批之间有个
 * barrier」—— 第 4 个项目要等整批跑完才轮到,而一次排空可以跑几分钟。
 * 信号量是「谁先到谁先拿,跑完一个立刻补一个」,既守住上界又不引入 barrier
 * (D3 要的「B 立刻被处理」正是靠没有 barrier)。
 *
 * 公平性是刻意的(FIFO 等待队列):不排队的话,后到的项目可能一直抢在
 * 前面,已经拿闩的那个项目永远轮不到 —— 表现是「某一个项目一直不动」,
 * 而那种故障在日志里几乎看不出来。
 */
function createSemaphore(permits: number): { acquire(): Promise<() => void> } {
  let free = permits;
  const waiters: Array<(release: () => void) => void> = [];

  const makeReleaser = (): (() => void) => {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = waiters.shift();
      if (next !== undefined) next(makeReleaser());
      else free++;
    };
  };

  return {
    acquire(): Promise<() => void> {
      if (free > 0) {
        free--;
        return Promise.resolve(makeReleaser());
      }
      return new Promise<() => void>((resolve) => {
        waiters.push(resolve);
      });
    },
  };
}

// ── 事件桥 ──────────────────────────────────────────────────────

/** 日志里怎么称呼一个上下文通道。`null` = 接待会话(见 migrations/012)。 */
function channelLabel(projectId: string | null): string {
  return projectId === null ? "接待会话" : `项目 ${projectId}`;
}

/**
 * 这个 agent 的回合该写进哪条会话通道(C4,设计 1 §2.11.6)。
 *
 * 判据只有一条、而且是**代码内常量**:`ROLE_SPECS[role].clientFacing`
 * (只有业务经理为 true)。它表达的是「甲方通道 = 甲方说的话 ∪ 面向甲方的角色的
 * 回合」—— 两边合起来才是甲方看得见的那条对话。
 *
 * **查不到这个 agent 时取 `internal`(fail-closed)**:宁可让一条发言留在内部
 * 会话里,也不把可能是内部角色的发言塞进甲方通道。这与前端
 * `channelOf`(web/src/lib/data.ts)是同一条纪律 —— 连失效方向都一样
 * (「晚一拍」而不是「通道分离失效」)。
 */
function channelForAgent(db: Database.Database, agentId: string): SessionChannel {
  const agent = getAgent(db, agentId);
  return agent !== null && ROLE_SPECS[agent.role].clientFacing ? "client" : "internal";
}

function bridge(
  ev: AgentSessionEvent,
  projectId: string | null,
  messageId: string,
  agentId: string,
  hub: PlatformHub,
  textBuf: string[],
  thinkBuf: string[],
): void {
  if (ev.type === "message_update") {
    const u = ev.assistantMessageEvent;
    // **两条流永不混流** —— 7-I 的现场是判据写成了不存在的 "thinking",
    // 于是内部推理落进了正文被展示给用户
    if (u.type === "text_delta" && typeof u.delta === "string") {
      textBuf.push(u.delta);
      hub.emitDelta(projectId, messageId, u.delta);
    } else if (u.type === "thinking_delta" && typeof u.delta === "string") {
      thinkBuf.push(u.delta);
      hub.emitThinking(projectId, messageId, u.delta);
    }
    return;
  }
  if (ev.type === "tool_execution_start") {
    // `tool_start` 也能建轮(前端),所以它同样要带说话人 —— 与 `bridge` 的
    // `message_start` 用的是同一个 agent(见 §2.10.2)
    hub.emitToolStart(projectId, messageId, {
      id: ev.toolCallId, name: ev.toolName, args: ev.args,
    }, agentId);
    return;
  }
  if (ev.type === "tool_execution_end") {
    hub.emitToolEnd(projectId, messageId, {
      id: ev.toolCallId, name: ev.toolName, result: ev.result, isError: ev.isError === true,
    });
  }
}


// ── CLI 入口 ────────────────────────────────────────────────────

/** 起服务并阻塞。返回一个 close 句柄(SIGTERM 时调)。 */
export async function runPlatformServe(opts: ServeOptions): Promise<{ close: () => void }> {
  const host = createPlatformHost(opts);

  log.ok(`Sansheng 平台服务`);
  log.muted(`  数据目录: ${opts.dataDir}`);
  if (!orgReady(host.booted.deps.db)) {
    log.muted(`  组织未就绪 —— 第一次收到消息或建项目时会自动播种`);
  }
  const projects = listProjectSummaries(host.booted.deps.db);
  log.muted(`  项目: ${projects.length} 个`);

  const server = serve(
    { fetch: host.app.fetch, port: opts.port, hostname: opts.host },
    (info) => {
      log.ok(`listening on http://${info.address}:${info.port}`);
      if (opts.open === true) {
        void import("open")
          .then(({ default: opener }) => opener(`http://${opts.host}:${info.port}`))
          .catch(() => {});
      }
    },
  ) as unknown as Server;

  const wss = attachHub(server, host.hub);

  /**
   * 优雅关闭。
   *
   * ── 为什么这段曾经关不掉(真机:用户连按 8 次 Ctrl-C 无反应)────────
   *
   * 原实现只有三行:`打印 → host.close() → server.close()`。三个问题叠在一起:
   *
   * ① **`server.close()` 不关闭已建立的连接** —— 它只停止接受新连接,然后等现有
   *    连接结束。而浏览器那条 **WebSocket 是长连接**,永远不结束,于是它永远等下去。
   * ② **没有 `process.exit()`** —— 所以「正在关闭」打完就卡在那儿。
   * ③ **没有幂等保护** —— 每按一次 Ctrl-C 就重跑一遍,于是同一句话打印 8 次,
   *    而观感上「它在响应」,实际什么也没推进。
   *
   * 现在:主动 terminate WS → 关宿主与 HTTP → **兜底超时自己退** →
   * 第二次信号**立刻退**(连按 Ctrl-C 就是标准的「别等了」表达)。
   */
  let closing = false;
  const shutdown = (signal: string) => {
    if (closing) {
      // 第二次信号 = 「别优雅了」。这条必须存在,否则一旦兜底也失效,
      // 用户就只剩 kill -9 一条路。
      log.muted(`再收到一次 ${signal} —— 直接退出`);
      process.exit(130);
    }
    closing = true;
    log.muted("平台服务收到退出信号,正在关闭");

    // ① 主动断开所有 WS。不做这一步,server.close() 的回调永远不会触发。
    for (const ws of wss.clients) ws.terminate();

    host.close();
    server.close();

    // ② 兜底:优雅关闭仍可能被别的东西撑着(三方库自己的句柄等)。
    //    到点自己退 —— 不把「能不能关掉」这件事交回给用户。
    setTimeout(() => {
      log.muted("优雅关闭超时(3s),直接退出");
      process.exit(130);
    }, 3000).unref();

    // ③ 关干净了也显式退。让「关掉了」与「卡住了」在观感上可区分 ——
    //    两者都只打印一行 muted 日志的话,用户分不出来。
    server.on("close", () => process.exit(0));
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));

  return { close: () => shutdown("close()") };
}

// 让 `ServerEvent` 的 import 不被 tree-shake 掉(类型只在编译期存在,
// 这里显式引用一次以免 lint 报未使用)
export type { ServerEvent };
