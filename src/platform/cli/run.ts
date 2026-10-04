/**
 * 平台 CLI · 跑一个工作项(BC6 的驱动)
 *
 * ── 为什么要有这个命令 ──────────────────────────────────────────
 *
 * BC6 执行层写完了,但**没有任何东西会调用它** —— 那正是这个项目反复栽的
 * 「落地了但没人读」(7-B 的提示词、8-B 的 Observer 都是)。一个没有调用方的
 * 执行层等于没有执行层。
 *
 * 所以这个命令是 BC6 的入口:立项(若未给)→ 拆出一个工作项 → 派给一个 worker
 * → 跑它 → 打印它到底做了什么。
 *
 * ── 它写真实库,且会明说 ────────────────────────────────────────
 *
 * 与 `platform smoke` 不同(那个用临时库),这个命令**写真实数据目录** ——
 * 它的意义就是真的把活干了。所以:
 *   - 组织(四个 agent)按需播种,幂等,并**如实报告播了什么**
 *   - 每一步做了什么都会打印出来
 *   - 不删任何东西
 */
import { join } from "node:path";
import type Database from "better-sqlite3";
import { bootPlatform, type BootedPlatform } from "../runtime/boot.js";
import { createPlatformSession } from "../runtime/session.js";
import { runWorkItem, renderExecutionReport } from "../runtime/execution.js";
import { getAgent, listAgents } from "../storage/repo/agents.js";
import { ensureOrg, ensureProjectOrg, pickWorker } from "../runtime/org.js";
import { insertProject, getProjectRow } from "../storage/repo/projects.js";
import { insertWork, type WorkRow } from "../storage/repo/works.js";
import type { Specialization } from "../identity/role.js";

export interface PlatformRunOptions {
  readonly dataDir: string;
  /** 要做的事 */
  readonly task: string;
  /** 已有项目 id;不给就新建一个 */
  readonly projectId?: string;
  /** 指定 worker;不给就用第一个 worker */
  readonly workerId?: string;
  readonly cwd: string;
  readonly timeoutMs?: number;
}

const out = (s = "") => process.stdout.write(`${s}\n`);
const rule = (t: string) => out(`\n── ${t} ${"─".repeat(Math.max(0, 56 - t.length))}`);

/** 新平台的固定组织:四个角色各一人。**幂等**。 */
export async function runPlatformRun(opts: PlatformRunOptions): Promise<boolean> {
  const booted = bootPlatform({ dataDir: opts.dataDir, clientLog: (l) => out(`  [client] ${l}`) });
  let session: Awaited<ReturnType<typeof createPlatformSession>> | null = null;

  try {
    rule("环境");
    out(`  数据目录: ${opts.dataDir}`);
    out(`  平台库:   ${booted.dbPath}（真实库 —— 会写入)`);
    out(`  cwd:      ${opts.cwd}`);

    if (booted.provider === null) {
      out(`\n✖ 没有配置任何 provider。`);
      return false;
    }
    if (booted.model === null) {
      out(`\n✖ 模型解析失败:${booted.provider.provider}/${booted.provider.modelId}`);
      return false;
    }
    out(`  provider: ${booted.provider.provider} / ${booted.provider.modelId}`);

    const at = booted.now();

    // ── 组织 ──
    rule("组织");
    const createdAgents = ensureOrg(booted.deps.db, at);
    if (createdAgents.length > 0) {
      out(`  新建:${createdAgents.join(", ")}`);
    } else {
      out(`  已就位(${listAgents(booted.deps.db).length} 个 agent)`);
    }

    // ── 项目 ──
    rule("项目");
    let projectId = opts.projectId;
    if (projectId === undefined) {
      projectId = booted.newId("pj");
      insertProject(booted.deps.db, {
        id: projectId,
        name: opts.task.slice(0, 40),
        client: "(未指定)",
        goal: opts.task,
        status: "active",
        createdAt: at,
      });
      ensureProjectOrg(booted.deps.db, projectId, at);
      out(`  新建项目 ${projectId}「${opts.task.slice(0, 40)}」`);
    } else {
      const p = getProjectRow(booted.deps.db, projectId);
      if (p === null) {
        out(`\n✖ 项目 ${projectId} 不存在。`);
        return false;
      }
      out(`  使用已有项目 ${projectId}「${p.name}」(状态 ${p.status})`);
      // 确保组织成员在项目里(幂等)
      ensureProjectOrg(booted.deps.db, projectId, at);
    }

    // ── 工作项 ──
    rule("工作项");
    const worker = pickWorker(booted.deps.db, opts.workerId);
    if (worker === null) {
      out(`\n✖ 找不到可用的 worker。`);
      return false;
    }
    const workId = booted.newId("w");
    const work: WorkRow = {
      id: workId,
      projectId,
      parentWorkId: null,
      title: opts.task.slice(0, 60),
      goal: opts.task,
      status: "open",
      assigneeAgentId: worker.id,
      createdAt: at,
      updatedAt: at,
    };
    insertWork(booted.deps.db, work);
    out(`  ${workId} 「${work.title}」→ ${worker.displayName}(${worker.role})`);

    // ── 建会话 ──
    rule("建会话");
    const created = await createPlatformSession(booted.deps, worker.id, projectId, {
      cwd: opts.cwd,
      agentDir: booted.settings.agentDir ?? join(opts.dataDir, "agent"),
      model: booted.model,
      dataDir: opts.dataDir,
    });
    if (!created.ok) {
      out(`\n✖ 建会话失败(${created.reason}):${created.detail}`);
      return false;
    }
    session = created;
    out(`  ✓ 工具面 ${created.wiring.customToolNames.length} 个 · 统一 allowlist ${created.wiring.allowlist.length} 个`);
    out(`  系统提示 ${created.wiring.systemPromptChars} 字符`);
    if (created.wiring.missingPromptUnits.length > 0) {
      out(`  ⚠️ 未落地的提示词单元:${created.wiring.missingPromptUnits.join(", ")}`);
    }

    // ── 真机不变式 ──
    const active = readActiveTools(created.session);
    if (active !== null) {
      const declared = new Set<string>(created.plan.tools);
      const missing = [...declared].filter((t) => !active.includes(t));
      if (missing.length > 0) {
        out(`  ✖ 声称要给但 SDK 没激活:${missing.join(", ")}`);
        return false;
      }
      out(`  ✓ 声明 vs SDK 激活一致(${active.length} 个)`);
    }

    // ── 跑它 ──
    rule("执行");
    out(`  ${opts.task}`);
    const result = await runWorkItem({
      session: created.session,
      db: booted.deps.db,
      workId,
      timeoutMs: opts.timeoutMs ?? 300_000,
    });

    rule("结果");
    out(renderExecutionReport(result));
    return result.outcome === "converged" || result.outcome === "blocked";
  } catch (err) {
    rule("异常");
    out(`  ✖ ${err instanceof Error ? err.message : String(err)}`);
    if (err instanceof Error && err.stack !== undefined) {
      for (const l of err.stack.split("\n").slice(1, 4)) out(`    ${l.trim()}`);
    }
    return false;
  } finally {
    // 会话与库都要关 —— CLI 是一次性进程,但不 close 会让 sqlite 留在 WAL 状态
    if (session !== null && session.ok) {
      try {
        session.session.dispose();
      } catch {
        // dispose 失败不该影响退出码
      }
    }
    booted.close();
  }
}


function readActiveTools(session: { getActiveToolNames?: unknown }): string[] | null {
  const fn = session.getActiveToolNames;
  if (typeof fn !== "function") return null;
  const names: unknown = (fn as () => unknown).call(session);
  return Array.isArray(names) ? names.filter((n): n is string => typeof n === "string") : null;
}
