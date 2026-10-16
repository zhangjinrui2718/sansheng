/**
 * 平台运行时 · 会话工厂(ADR-001 §2 Q1)
 *
 * ── 这是「接线」的落点 ──────────────────────────────────────────
 *
 * 在此之前,`ROLE_SPECS` / `solveToolset` / `dispatch` 都只是**声明** ——
 * 建好但没通电。这个模块把它们接到真实的 Pi session 上:
 *
 *   1. 规划:planAgentSession → 三重门控算出工具面
 *   2. 分道:splitToolset   → SDK 内置进 allowlist,平台工具进 customTools
 *   3. 包壳:toSdkTools     → 平台工具 → SDK ToolDefinition(无逻辑薄壳)
 *   4. 建会话:createAgentSession({ tools, customTools, cwd, agentDir, model })
 *
 * ── 为什么会话建在平台侧而不是改旧 AgentKernel ────────────────────
 *
 * ADR-001 §2 Q1 的决策,用户已确认。理由是**爆炸半径**:改旧 kernel 意味着
 * 新授权模型的第一次真实运行直接发生在旧系统核心链路上 —— 一旦出问题,
 * 分不清是新模型错了还是接线错了,而且旧系统立刻不可用。
 *
 * 代价是过渡期有两套会话创建点。可接受:它们服务两套互不相干的工具与角色
 * 体系,旧的那套会在阶段 8 整体删除。
 *
 * ── DI seam ────────────────────────────────────────────────────
 *
 * `createSession` 可注入。生产走真的 `createAgentSession`;测试注入一个假的,
 * 就能断言「到底把什么交给了 SDK」而**不需要 provider / API key / 网络**。
 * 这是本项目吃过亏的地方(5 个 E2E blocker 至今只有 fakeLlmCall 验证)。
 */
import {
  createAgentSession, DefaultResourceLoader,
  createMcpExtension, createToolSearchExtension,
  type AgentSession, type ExtensionFactory, type LoadedMcpConfig, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import type { Model } from "@earendil-works/pi-ai";

/**
 * 平台侧的模型类型别名。**只在这一处定义。**
 *
 * SDK 自己的签名就是 `model?: Model<any>`(`CreateAgentSessionOptions` 原文)——
 * 因为 `Model` 的泛型参数 `constraint Api` 在跨 provider 场景下无法收窄。
 * 这里照抄 SDK 的形状,不自己发明一个更窄的类型。
 *
 * 注意这是**类型参数**,不是类型断言 —— 项目禁止的是后者(那条检查仍为 0)。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PlatformModel = Model<any>;
import {
  buildToolContext, planAgentSession,
  type AgentSessionPlan, type RuntimeDeps,
} from "./assembly.js";
import { classifyToolset, toSdkTools } from "./sdkAdapter.js";
import { composeSystemPrompt } from "./promptAssembly.js";
import { dispatch } from "../tools/registry.js";
import { toLoadedMcpConfig } from "../mcp/piConfig.js";
import { log } from "../../shared/log.js";

/**
 * `bindExtensions` 的收窄。
 *
 * ⚠️ 平台**禁止** `as any`、也**不许新增** `as never`(见 AGENTS.md 编码纪律),
 * 而这一段是全项目少数「SDK 类型够用、但调用点必须防御」的地方:
 * `createSession` 是一个**可注入的 seam**(测试会注入假 session),
 * 那个假货不一定有 `bindExtensions`。所以这里用 module-level type guard 收窄,
 * 而不是一次断言 —— 窄化走 guard 是本项目的规矩。
 *
 * **为什么必须绑**(坑 2):`dist/core/sdk.js` 里 `bindExtensions` **零调用**;
 * 它只在 CLI / 交互模式里被调。不显式绑 ⇒ 扩展收不到 `session_start`
 * ⇒ MCP 扩展不去连 server ⇒ 一份写得完全正确的 `servers.json` 静默无效。
 */
interface BindableSession {
  bindExtensions(bindings: Record<string, unknown>): Promise<unknown>;
}

/** module-level type guard(项目纪律:窄化写 guard,不用断言糊过去)。 */
function isBindableSession(s: unknown): s is AgentSession & BindableSession {
  return (
    typeof s === "object" && s !== null && typeof (s as { bindExtensions?: unknown }).bindExtensions === "function"
  );
}

/** `createAgentSession` 的最小结构类型 —— 只声明我们用到的字段,便于注入假货。 */
export interface CreateSessionFn {
  (opts: {
    cwd?: string;
    agentDir?: string;
    model?: PlatformModel;
    tools?: string[];
    customTools?: ReturnType<typeof toSdkTools>;
    /**
     * 2026-10-16:内置扩展工厂(MCP / tool_search)。
     *
     * ⚠️ **不传就没有 MCP**(坑 1)—— `DefaultResourceLoader` 默认不装内置扩展,
     * 而 SDK 自己从不代为安装。这个参数是那一把开关,所以它**必须**在类型上被
     * 声明出来(否则测试注入的假 `createSession` 会把它悄悄丢掉,
     * 而那正是「声称已接线但实际未接线」的形态)。
     */
    extensionFactories?: readonly ExtensionFactory[];
  }): Promise<{ session: AgentSession }>;
}

export interface PlatformSessionOptions {
  /** 会话工作目录(代码工具的根) */
  readonly cwd: string;
  /** Pi 全局配置目录 */
  readonly agentDir: string;
  /** 已解析的模型 */
  readonly model?: PlatformModel;
  /** 测试 seam:替换真实 SDK 调用 */
  readonly createSession?: CreateSessionFn;
  /**
   * 数据目录 —— 提示词单元从这里读(`harness/system_prompts/{unitId}.md`)。
   * 缺省不注入提示词,并把「未注入」如实报进 wiring。
   */
  readonly dataDir?: string;
  /** 测试 seam:替换 resourceLoader 构造(避免真读盘 + reload) */
  readonly makeResourceLoader?: (systemPrompt: string) => Promise<ResourceLoader>;
}

export type PlatformSessionFailure =
  | { readonly ok: false; readonly reason: "assembly"; readonly detail: string }
  | { readonly ok: false; readonly reason: "unplaceable_tools"; readonly detail: string; readonly tools: readonly string[] };

export type PlatformSessionResult =
  | {
      readonly ok: true;
      readonly session: AgentSession;
      /** 规划结果 —— 诊断/审计要它(算出了什么、挡下了什么) */
      readonly plan: AgentSessionPlan;
      /** 实际交给 SDK 的两条通道(测试与诊断断言这个) */
      readonly wiring: {
        readonly allowlist: readonly string[];
        readonly customToolNames: readonly string[];
        /**
         * 真正送进系统提示的提示词单元。
         * **这两个字段是 7-B 那一课的守卫** —— 当时提示词「落地了但没人读」,
         * 而没有任何东西报出这件事。
         */
        readonly loadedPromptUnits: readonly string[];
        readonly missingPromptUnits: readonly string[];
        readonly systemPromptChars: number;
        /**
         * **这一条会话算出来的 MCP server**(2026-10-16)。名字与 `allowlist` 里的
         * `mcp__` 模式必须对得上:`mcpServers` 非空而无对应模式 ⇒ pi 侧 fail-open
         * (坑 3);有模式而 `mcpServers` 空 ⇒ 一个空承诺。
         */
        readonly mcpServers: readonly string[];
        /** 交给 pi 的 `mcp__<server>__*` 模式(与 `allowlist` 同源)。 */
        readonly mcpPatterns: readonly string[];
        /** 授权里有、目录里没有的 server 名。**不静默生效**,必须看得见。 */
        readonly mcpUnknownServers: readonly string[];
        /** 解不开的 secret(`enc:` 前缀不对 / keyring 不是同一个)。**只含键名**。 */
        readonly mcpUnresolvedSecrets: readonly string[];
        /**
         * ⚠️ **Wave 1 不提供 MCP 连接状态端点** —— pi 把连接状态写进
         * `<agentDir>/mcp.log`,平台读不到。与 `ProjectLiveView.runtime =
         * "unavailable"` 同一条纪律:**宁可没有,也不伪造一个「已连接」**。
         */
        readonly mcpConnectionState: "unavailable";
        /**
         * `bindExtensions` 失败的原因(坑 2)。
         *
         * ⚠️ 绑定失败**不许静默吞掉**,也**不许**让整个建会话失败:失败时这一条
         * 会话一个 MCP 工具都没有(比给多了安全得多),而用户需要知道「为什么我配的
         * server 没生效」—— 不报出来就是「声称有、实际没有」(7-N)。
         */
        readonly mcpBindError?: string;
      };
    }
  | PlatformSessionFailure;

/**
 * 为一个 agent 在某个项目里建立会话。
 *
 * `projectId === null` = **接待会话**(第一个项目之前,见 migrations/012):
 * 工具面由 `planAgentSession(deps, agentId, null)` 决定 —— 只有
 * `project_open` / `memory_*`,项目内工具根本进不了 SDK 的名单。
 *
 * **失败一律显式返回**,不抛异常 —— 会话建立是启动路径,异常会以栈回溯的形式
 * 出现,而调用方本可以给出一句可读的原因。
 */
export async function createPlatformSession(
  deps: RuntimeDeps,
  agentId: string,
  projectId: string | null,
  opts: PlatformSessionOptions,
): Promise<PlatformSessionResult> {
  // 1. 规划
  const planned = planAgentSession(deps, agentId, projectId);
  if (!planned.ok) {
    return { ok: false, reason: "assembly", detail: `${planned.reason}: ${planned.detail}` };
  }
  const plan = planned.plan;

  // 2. 分类 + 拼统一 allowlist
  //    ⚠️ MCP 的 `mcp__<server>__*` 模式**从 plan 里取**,不进 `tools` ——
  //    它们不在闭合 `ToolName` 集里(见 sdkAdapter 的 `mcpPatterns` 注释)。
  const split = classifyToolset(plan.tools, plan.mcp.patterns);
  if (split.unplaceable.length > 0) {
    // 这一条必须硬失败:工具面声称有、但两条通道都放不进去 = 8-A 的形态。
    // 放行的话模型会看到不存在的工具,然后编造。
    return {
      ok: false,
      reason: "unplaceable_tools",
      detail:
        `这些工具在求解结果里,但既不是 SDK 内置、也不在平台注册表:` +
        `${split.unplaceable.join(", ")} —— 交不出去的工具等于声称有而实际没有`,
      tools: split.unplaceable,
    };
  }

  // 3. 包壳。上下文由 dispatchOne 每次调用现取(见上),
  //    所以这一层壳里没有任何逻辑 —— 它只搬元数据。
  const customTools = toSdkTools(split.platformTools, (tool, args) => {
    const c = buildToolContext(deps, agentId, projectId);
    if (!c.ok) {
      // 逐调用重新校验 —— 项目可能在会话中途被关闭,或把该 agent 移出;
      // 接待会话则可能在同一条会话里刚被 project_open 建出了项目。
      return {
        ok: false as const,
        code: "denied" as const,
        message: `工具调用被拒:${c.detail}`,
      };
    }
    return dispatch(tool.name, args, c.ctx);
  });

  // 3.5 提示词装配 —— **这一步不能省**。
  //     首跑冒烟时业务经理自称「AI 编码助手」,因为单元算出来了却没送达模型;
  //     那正是 7-B 的「死接线」形态。promptUnits 只有在真的拼进系统提示之后
  //     才算数。
  // 3.6 MCP 接线 —— **坑 1 / 3 / 4 的落点**。
  //
  // 顺序很重要:配置先算出来(纯函数,可测),再随 resourceLoader 装进扩展工厂,
  // 最后 `bindExtensions` 触发连接(坑 2)。
  const mcpConfig = toLoadedMcpConfig(plan.mcp, deps.dataDir, deps.secretStore);
  const mcpSource = mcpConfig.config;

  /** 恒等包装:让 `loadConfig` 的返回类型被显式标注(而不是靠推断传出去)。 */
  const loadMcpConfig = (): LoadedMcpConfig => mcpSource;

  let resourceLoader: ResourceLoader | undefined;
  let loadedPromptUnits: string[] = [];
  let missingPromptUnits: string[] = [];
  let systemPromptChars = 0;

  // ⚠️ **扩展工厂与 resourceLoader 无关**:即使提示词单元缺失(不建
  // `DefaultResourceLoader`),MCP 也必须照常装上 —— 否则「盘上缺一个提示词单元」
  // 会连带把外部工具也关掉,那是两个完全无关的故障。
  const extensionFactories: ExtensionFactory[] = [
    createToolSearchExtension(),
    createMcpExtension({
      loadConfig: loadMcpConfig,
      // ⚠️ Wave 1 **不支持 OAuth 登录**(三生没有 TUI,跑不了 `pi mcp login`
      // 的浏览器回调)。pi 的默认实现会去开系统浏览器 —— 那在三生里等于
      // 「静默弹一个窗口,然后没人能完成登录」。所以只记下来。
      openUrl: (url: string) => {
        log.warn(
          `mcp: 某个 server 需要 OAuth 登录,而 Wave 1 不支持(平台没有浏览器回调)。URL=${url}\n` +
            `        处置:该 server 改用 Authorization header,或先用 secret 写一个长期 token` +
            `(PUT /api/mcp/servers/<name>/secrets)`,
        );
      },
    }),
  ];

  if (opts.dataDir !== undefined) {
    const composed = composeSystemPrompt(opts.dataDir, plan.agent.role);
    loadedPromptUnits = [...composed.loadedUnits];
    missingPromptUnits = [...composed.missingUnits];
    systemPromptChars = composed.text.length;
    if (composed.text.trim() !== "") {
      if (opts.makeResourceLoader !== undefined) {
        resourceLoader = await opts.makeResourceLoader(composed.text);
      } else {
        const loader = new DefaultResourceLoader({
          cwd: opts.cwd,
          agentDir: opts.agentDir,
          // **append 语义**:保留 SDK 默认的 preamble / 工具说明 / 规则段,
          // 只把角色提示追加在其后。整体替换会丢掉 SDK 自己那份工具协议说明,
          // 而 8-F 的教训正是「工具协议段必须渲染参数清单」。
          appendSystemPromptOverride: (base: readonly string[]) => [...base, composed.text],
          // ⚠️ 坑 1:不传这一项 ⇒ SDK 会话里**没有 MCP 扩展**。
          extensionFactories,
        });
        // 外部传入 resourceLoader 时 SDK **不代为 reload**(它只 reload 自建的)
        // —— 不显式 reload 的话提示词不会生效,又是一个静默死接线。
        await loader.reload();
        resourceLoader = loader;
      }
    }
  }

  // 4. 建会话
  const create = opts.createSession ?? createAgentSession;
  const created = await create({
    cwd: opts.cwd,
    agentDir: opts.agentDir,
    ...(resourceLoader !== undefined ? { resourceLoader } : {}),
    ...(opts.model !== undefined ? { model: opts.model } : {}),
    // `tools` 是**统一 allowlist**(内置 + 平台 + MCP 模式)。
    // **不能只放内置** —— SDK 的 isAllowedTool 同时对 customTools 过滤,
    // 只放内置等于把平台工具一起关掉(首跑冒烟实测 0 个激活)。
    // ⚠️ 而 `mcp__<server>__*` 模式**必须在这里** —— 它是坑 3 那把开关:
    //    pi 的 allowlist 不含任何 `mcp__` 条目时会**保留全部 MCP 工具注册**。
    tools: [...split.unifiedAllowlist],
    customTools,
    // 外部注入的 resourceLoader(测试 seam)里**不会**有我们算的扩展工厂,
    // 所以它们必须同时交给会话本身 —— 否则 seam 一换,MCP 就静默消失。
    extensionFactories,
  });

  // 5. 坑 2:显式绑定。**失败必须报进 wiring**,不能静默吞掉,也不能让建会话失败。
  let mcpBindError: string | undefined;
  if (!isBindableSession(created.session)) {
    mcpBindError =
      `建出来的 session 没有 bindExtensions —— 扩展(MCP / tool_search)收不到 session_start,` +
      `MCP server 不会被连上。若这是测试注入的假 session,属预期;生产路径不该出现`;
  } else {
    try {
      await created.session.bindExtensions({});
    } catch (err) {
      mcpBindError = err instanceof Error ? err.message : String(err);
      log.warn(`mcp: bindExtensions 失败(${plan.agent.role})—— 这一条会话没有任何外部工具:${mcpBindError}`);
    }
  }

  const grantedServers = plan.mcp.servers.filter((s) => s.granted).map((s) => s.name);

  return {
    ok: true,
    session: created.session,
    plan,
    wiring: {
      allowlist: [...split.unifiedAllowlist],
      customToolNames: customTools.map((t) => t.name),
      loadedPromptUnits,
      missingPromptUnits,
      systemPromptChars,
      mcpServers: grantedServers,
      mcpPatterns: [...plan.mcp.patterns],
      mcpUnknownServers: [...plan.mcp.unknownServers],
      mcpUnresolvedSecrets: [...mcpConfig.unresolved],
      mcpConnectionState: mcpConfig.connectionState,
      ...(mcpBindError !== undefined ? { mcpBindError } : {}),
    },
  };
}
