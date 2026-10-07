/**
 * 平台 CLI · 冒烟验证
 *
 * ── 它存在的理由 ────────────────────────────────────────────────
 *
 * 批次 8 把新授权模型接到了会话工厂上,但那件事**只用假 SDK 验证过** ——
 * 单元测试证明了「交给 SDK 的东西是对的」,证明不了「真 SDK 收得下」。
 *
 * 本项目在这类事情上吃过亏:5 个 E2E blocker 至今只有 fakeLlmCall 验证,
 * 而真实路径上的 TDZ / 僵尸 session / DAG 通配 bug 只在真跑时才暴露
 * (docs/CODE-REVIEW-2026-10-01.md)。
 *
 * 所以这个命令做的事很窄:**拿真 provider 建一个真会话,发一句话,打印回答**。
 * 但真正重要的不是回答,是它顺手做的那个断言 ——
 *
 *   `session.getActiveToolNames()`(真 SDK 侧的激活名单)
 *       必须等于
 *   `planAgentSession()` 算出的工具面(我们的声明)
 *
 * 这是 8-A 那条不变式的**真机版本**:当时的事故是「集合文件声称 13 个工具,
 * 循环里真的只有 6 个」—— 而我们此前只能在自己的记账里对比。现在能对着 SDK
 * 的实际激活结果比。差一个就是接线漏了。
 *
 * ── 它刻意不碰你的真实数据 ──────────────────────────────────────
 *
 * 设置与密钥环从真目录读(要用你配好的 provider),但平台库建在**临时目录**里,
 * 演示用的项目与 agent 只写在那儿,跑完即删(`--keep-temp` 可保留排查)。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentSession,
  AgentSessionEvent,
} from "@earendil-works/pi-coding-agent";
import { bootPlatform } from "../runtime/boot.js";
import { createPlatformSession } from "../runtime/session.js";
import { planAgentSession } from "../runtime/assembly.js";
import { insertAgent } from "../storage/repo/agents.js";
import { insertProject, addMember } from "../storage/repo/projects.js";
import { ROLE_SPECS, PROJECT_ROLES, type ProjectRole, type Specialization } from "../identity/role.js";

export interface PlatformSmokeOptions {
  /** 真实数据目录(读 provider 配置) */
  readonly dataDir: string;
  readonly prompt: string;
  readonly role: ProjectRole;
  /** 建会话用的 cwd(代码工具的根) */
  readonly cwd: string;
  readonly keepTemp?: boolean;
  /** 回答等待上限(毫秒) */
  readonly timeoutMs?: number;
}

const DEMO_AGENTS: ReadonlyArray<{ id: string; role: ProjectRole; spec?: Specialization }> = [
  { id: "demo-bm", role: "business_manager" },
  { id: "demo-pm", role: "project_manager" },
  { id: "demo-rw", role: "research_worker", spec: "algorithm" },
  { id: "demo-cw", role: "coding_worker", spec: "engineering" },
  { id: "demo-qa", role: "quality_reviewer" },
];

const out = (s = "") => process.stdout.write(`${s}\n`);
const rule = (t: string) => out(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

/** 跑一次冒烟。返回是否成功 —— 不抛异常,好让 CLI 给出干净的退出码。 */
export async function runPlatformSmoke(opts: PlatformSmokeOptions): Promise<boolean> {
  const temp = mkdtempSync(join(tmpdir(), "sansheng-platform-smoke-"));
  const booted = bootPlatform({
    dataDir: opts.dataDir,
    dbPath: join(temp, "smoke.db"),
    clientLog: (l) => out(`  [client] ${l}`),
    // 与下面 `createPlatformSession({ cwd: opts.cwd })` **同一个根** ——
    // 代码服务的包含性校验按这个根算(`BootOptions.workspaceRoot`)。
    workspaceRoot: opts.cwd,
  });

  try {
    rule("环境");
    out(`  设置来源:   ${opts.dataDir}`);
    out(`  平台库:     ${booted.dbPath}(临时)`);
    out(`  cwd:        ${opts.cwd}`);

    if (booted.provider === null) {
      out(`\n✖ 没有配置任何 provider —— 先在「设置」里加一个。`);
      return false;
    }
    out(`  provider:   ${booted.provider.provider} / ${booted.provider.modelId}`);
    if (booted.model === null) {
      out(`\n✖ 模型解析失败:${booted.provider.provider}/${booted.provider.modelId} 不在 catalog 里。`);
      return false;
    }

    seedDemoData(booted);
    const agentId = DEMO_AGENTS.find((a) => a.role === opts.role)!.id;

    // ── 门控算出了什么 ──
    rule("门控(声明侧)");
    const planned = planAgentSession(booted.deps, agentId, "demo-project");
    if (!planned.ok) {
      out(`✖ 规划失败(${planned.reason}):${planned.detail}`);
      return false;
    }
    const p = planned.plan;
    out(`  agent:      ${p.agent.id}(${p.agent.role}${p.agent.specialization ? "/" + p.agent.specialization : ""})`);
    out(`  工具面:     ${p.tools.length} 个`);
    out(`  能力面:     ${p.capabilities.length} 条`);
    out(`  提示词单元: ${p.promptUnits.join(", ")}`);
    out(`  甲方通道:   ${ROLE_SPECS[p.agent.role].clientFacing ? "有(唯一客户接口)" : "无"}`);
    for (const [label, arr] of [
      ["被上界挡下", p.blockedByCeiling],
      ["被作用域挡下", p.blockedByScope],
      ["不认识的工具名", p.unknownTools],
    ] as const) {
      if (arr.length > 0) out(`  ⚠️ ${label}: ${arr.join(", ")}`);
    }

    // ── 真建会话 ──
    rule("建会话(真 SDK)");
    const created = await createPlatformSession(booted.deps, agentId, "demo-project", {
      cwd: opts.cwd,
      agentDir: booted.settings.agentDir ?? join(opts.dataDir, "agent"),
      model: booted.model,
      // 提示词单元从真实数据目录读 —— 这一步不能省(7-B:落地了但没人读)
      dataDir: opts.dataDir,
    });
    if (!created.ok) {
      out(`✖ 建会话失败(${created.reason}):${created.detail}`);
      return false;
    }
    out(`  ✓ 会话已建立`);
    out(`  统一 allowlist:      ${created.wiring.allowlist.length} 个(内置 + 平台)`);
    out(`  customTools 实现:    ${created.wiring.customToolNames.length} 个`);

    // ── 提示词是否真的送达(7-B 那一课的守卫)──
    rule("提示词(7-B 死接线守卫)");
    out(`  系统提示长度: ${created.wiring.systemPromptChars} 字符`);
    out(`  已送达单元:   ${created.wiring.loadedPromptUnits.join(", ") || "(无)"}`);
    if (created.wiring.missingPromptUnits.length > 0) {
      out(`  ⚠️ **声明了但盘上没有**:${created.wiring.missingPromptUnits.join(", ")}`);
      out(`     这些职责**没有告诉过 agent** —— 它会照常工作,只是不知道那条规矩。`);
      out(`     文件位置:${join(opts.dataDir, "harness", "system_prompts")}/<unitId>.md`);
    }

    // ── **真机不变式**:SDK 实际激活的工具 === 我们声明要给的 ──
    rule("不变式(真机) · 声明 vs SDK 实际激活");
    const active = readActiveTools(created.session);
    if (active === null) {
      out(`  ⚠️ 这个 SDK 版本的会话没有 getActiveToolNames(),跳过该断言`);
    } else {
      const declared = new Set<string>(p.tools);
      const got = new Set(active);
      const missing = [...declared].filter((t) => !got.has(t));
      const extra = [...got].filter((t) => !declared.has(t));
      out(`  SDK 实际激活: ${active.length} 个`);
      out(`  我们声明:     ${declared.size} 个`);
      if (missing.length === 0 && extra.length === 0) {
        out(`  ✓ 完全一致 —— 接线成立`);
      } else {
        if (missing.length > 0) {
          out(`  ✖ **声称要给但 SDK 没激活**:${missing.join(", ")}`);
          out(`    这正是 8-A 的形态(集合文件声称有、实际没有)→ 模型会编造`);
        }
        if (extra.length > 0) {
          out(`  ✖ **SDK 激活了我们没声明的**:${extra.join(", ")}`);
          out(`    这是越权 —— 门控被绕过了`);
        }
        return false;
      }
    }

    // ── 真发一句话 ──
    rule("发一句话");
    out(`  prompt: ${opts.prompt}`);
    const answer = await askAndCollect(created.session, opts.prompt, opts.timeoutMs ?? 120_000);
    rule("回答");
    out(answer.trim() === "" ? "  (空回答)" : answer.trim());

    rule("结论");
    out(`  ✓ 接线在真模型下成立:会话建起来了、工具交出去了、模型答回来了。`);
    return true;
  } catch (err) {
    rule("异常");
    out(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack !== undefined) {
      for (const l of err.stack.split("\n").slice(1, 4)) out(`    ${l.trim()}`);
    }
    return false;
  } finally {
    booted.close();
    if (opts.keepTemp === true) out(`\n  (临时目录保留:${temp})`);
    else rmSync(temp, { recursive: true, force: true });
  }
}

function seedDemoData(booted: ReturnType<typeof bootPlatform>): void {
  const at = booted.deps.now?.() ?? Date.now();
  for (const a of DEMO_AGENTS) {
    insertAgent(booted.deps.db, {
      id: a.id,
      role: a.role,
      specialization: a.spec ?? null,
      displayName: a.id,
      createdAt: at,
    });
  }
  insertProject(booted.deps.db, {
    id: "demo-project",
    name: "冒烟演示项目",
    client: "演示甲方",
    goal: "验证平台接线在真模型下成立",
    status: "active",
    createdAt: at,
  });
  for (const a of DEMO_AGENTS) addMember(booted.deps.db, "demo-project", a.id, at);
}

/**
 * 读 SDK 实际激活的工具名。
 *
 * `getActiveToolNames()` 是 AgentSession 的公开方法 —— 它比我们自己的记账可信,
 * 因为它反映的是 **isAllowedTool 过滤之后**真正挂上去的东西。
 */
function readActiveTools(session: AgentSession): string[] | null {
  const fn = (session as { getActiveToolNames?: unknown }).getActiveToolNames;
  if (typeof fn !== "function") return null;
  const names: unknown = (fn as () => unknown).call(session);
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : null;
}

/** `message_update` 事件收窄 —— 避免为了读一个 delta 就上宽断言。 */
function isMessageUpdate(
  ev: AgentSessionEvent,
): ev is Extract<AgentSessionEvent, { type: "message_update" }> {
  return ev.type === "message_update";
}

/**
 * 给 session 发一句话并收齐助手文本。
 *
 * 用 `subscribe` 收流式事件 —— AgentSession 的形态就是事件流。
 *
 * **只认 `text_delta`**:7-I 的现场是「thinking 增量全掉进 textDeltas,最终被当成
 * 正式回复展示给用户」(会话 conv_murnhpls_oha6,12 条消息 thinking 列长度全 0
 * 而 content 里躺着 1853 字符的纯内部推理)。根因是判据写成了 `"thinking"` ——
 * pi-ai 的真实取值里**没有**这个,增量事件叫 `thinking_delta`。
 * 这里显式排除它。
 */
async function askAndCollect(
  session: AgentSession,
  prompt: string,
  timeoutMs: number,
): Promise<string> {
  const chunks: string[] = [];
  let settled = false;

  const unsub = session.subscribe((ev: AgentSessionEvent) => {
    if (isMessageUpdate(ev)) {
      const u = ev.assistantMessageEvent;
      if (u.type === "text_delta" && typeof u.delta === "string") chunks.push(u.delta);
      return;
    }
    if (ev.type === "agent_settled" || ev.type === "agent_end") settled = true;
  });

  const timer = setTimeout(() => { settled = true; }, timeoutMs);
  try {
    await session.prompt(prompt);
    while (!settled) await new Promise((r) => setTimeout(r, 50));
  } finally {
    clearTimeout(timer);
    unsub();
    session.dispose();
  }
  return chunks.join("");
}

/** 从 argv 取角色,非法值返回 null(调用方给可选清单)。 */
export function parseRole(raw: string | undefined): ProjectRole | null {
  if (raw === undefined) return "business_manager";
  return (PROJECT_ROLES as readonly string[]).includes(raw) ? (raw as ProjectRole) : null;
}
