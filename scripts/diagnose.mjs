#!/usr/bin/env node
/**
 * sansheng 故障诊断工具 —— 把「翻库捞现场」这件事固化成一条命令。
 *
 * 背景(2026-10-02 批次 7):排查一次「plan 整轮失败」时,真正的证据藏在
 * `blackboards.artifacts_json` 里那条 `exec-err-*` note 的 body(保存着
 * 失败那一刻的**原始 LLM 输出**)。找到它花了大量手工 sqlite3 + node -e
 * 拼 JSON 的时间。这个脚本把那套动作固化下来。
 *
 * 用法:
 *   node scripts/diagnose.mjs                概览:所有会话 + 失败统计(先看这个)
 *   node scripts/diagnose.mjs <convId>       单会话全量诊断(含失败现场原文)
 *   node scripts/diagnose.mjs --harness      harness 管理面体检(5 个面 + 提示词单元 + 死接线)
 *   node scripts/diagnose.mjs --help
 *
 * 只读。不会写库、不改文件。
 */
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import Database from "better-sqlite3";

/* ── 数据目录解析:与 src/cli/commands.ts dataDir() 同一优先级 ── */
function dataDir() {
  if (process.env.SANSHENG_DATA) return process.env.SANSHENG_DATA;
  return join(homedir(), ".sansheng");
}

const DIR = dataDir();
const DB = join(DIR, "sansheng.db");

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

function trunc(s, n) {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

function ts(ms) {
  if (!ms) return "-";
  const d = new Date(Number(ms));
  return `${d.toLocaleDateString()} ${d.toLocaleTimeString().slice(0, 8)}`;
}

function open() {
  if (!existsSync(DB)) {
    console.error(c.red(`找不到数据库:${DB}`));
    console.error(c.dim("服务是否已启动过?sansheng start 会在首次运行时建库。"));
    process.exit(1);
  }
  return new Database(DB, { readonly: true });
}

/**
 * 收集一个会话的全部 artifacts。
 *
 * 关键结构事实(M3+ 之后):**没有独立的 artifacts 表**。所有 artifact 以
 * JSON 数组存在 `blackboards.artifacts_json` 这一列里,一个 conversation
 * 可能有多行 blackboard(每轮 run 一行),要全部合并。
 *
 * 另外 `blackboards` 的 `goal` / `plan_json` / `todos_json` 是 M3b 遗留列,
 * 在 artifact 体系下**长期为空且有误导性** —— 看到 goal="" 不代表没跑。
 */
function collectArtifacts(db, convId) {
  const rows = db
    .prepare(`SELECT id, goal, plan_json, artifacts_json FROM blackboards
              WHERE conversation_id = ? ORDER BY created_at ASC`)
    .all(convId);
  const byId = new Map();
  let legacyOnly = false;
  for (const r of rows) {
    let arr = [];
    try {
      arr = JSON.parse(r.artifacts_json || "[]");
    } catch {
      arr = [];
    }
    if (!Array.isArray(arr) || arr.length === 0) legacyOnly = true;
    for (const a of arr) if (a && a.id && !byId.has(a.id)) byId.set(a.id, a);
  }
  return { artifacts: [...byId.values()], rowCount: rows.length, legacyOnly };
}

const STATUS_ICON = {
  resolved: c.green("✓"),
  failed: c.red("✗"),
  open: c.dim("○"),
  in_progress: c.yellow("◐"),
  waiting_for_decision: c.yellow("?"),
  superseded: c.dim("-"),
};

/* ─────────────────────────── 概览 ─────────────────────────── */

function overview(db) {
  console.log(c.bold(`\nsansheng 诊断 · 数据目录 ${DIR}`));
  if (existsSync(join(DIR, "sansheng.db-wal"))) {
    const wal = statSync(join(DIR, "sansheng.db-wal")).size;
    if (wal > 1024 * 1024) {
      console.log(c.dim(`  (db-wal ${(wal / 1024 / 1024).toFixed(1)}MB —— 正常,WAL 模式常态,不影响读取)`));
    }
  }

  const convs = db
    .prepare(`SELECT id, title, created_at, last_active_at, message_count, model_id, provider
              FROM conversations ORDER BY last_active_at DESC`)
    .all();

  if (convs.length === 0) {
    console.log(c.yellow("\n库里还没有任何会话。"));
    return;
  }

  console.log(c.bold(`\n共 ${convs.length} 个会话\n`));
  let bad = 0;
  for (const cv of convs) {
    const { artifacts, legacyOnly } = collectArtifacts(db, cv.id);
    const by = (s) => artifacts.filter((a) => a.status === s).length;
    const failed = by("failed");
    const resolved = by("resolved");
    const intents = artifacts.filter((a) => a.kind === "intent");
    const intentBad = intents.filter((a) => a.status === "failed").length;

    const flag = failed > 0 || intentBad > 0 ? c.red(" ← 有失败") : c.green(" ✓");
    if (failed > 0 || intentBad > 0) bad++;

    console.log(
      `${flag} ${c.bold(cv.id)}  ${c.dim(ts(cv.last_active_at))}`,
    );
    console.log(
      `   ${c.dim(trunc(cv.title, 60))}`,
    );
    console.log(
      `   ${c.dim(`model=${cv.provider}/${cv.model_id} msgs=${cv.message_count ?? 0} artifacts=${artifacts.length}` +
        ` (resolved=${resolved} failed=${failed})`)}` +
        (legacyOnly && artifacts.length === 0 ? c.yellow("  [artifacts_json 为空,可能只有遗留列]") : ""),
    );

    if (failed > 0) {
      // 找第一个真失败(排除 cascade 出来的下游)
      const firsts = artifacts.filter(
        (a) => a.kind === "todo" && a.status === "failed" && !/^cascade from/.test(a.metadata?.errorReason ?? ""),
      );
      for (const f of firsts.slice(0, 3)) {
        console.log(`     ${c.red("根因候选")} ${c.dim(f.id)} ${trunc(f.title, 46)}`);
        const note = artifacts.find(
          (a) => a.kind === "note" && (a.metadata?.relatedArtifacts ?? []).includes(f.id),
        );
        if (note) console.log(`       ${c.yellow("现场")} ${c.dim(note.title)}  →  ${c.cyan("node scripts/diagnose.mjs " + cv.id)}`);
      }
      const cascaded = artifacts.filter(
        (a) => a.status === "failed" && /^cascade from/.test(a.metadata?.errorReason ?? ""),
      );
      if (cascaded.length) {
        console.log(`     ${c.dim(`另有 ${cascaded.length} 个是级联失败(非独立根因)`)}`);
      }
    }
  }
  console.log(
    bad > 0
      ? c.yellow(`\n${bad} 个会话存在失败。用上面的 id 跑详情。\n`)
      : c.green("\n没有发现失败会话。\n"),
  );
}

/* ─────────────────────── 单会话详情 ─────────────────────── */

async function detail(db, convId) {
  const cv = db.prepare(`SELECT * FROM conversations WHERE id = ?`).get(convId);
  if (!cv) {
    console.error(c.red(`找不到会话 ${convId}`));
    process.exit(1);
  }
  console.log(c.bold(`\n══ 会话 ${convId} ══`));
  console.log(c.dim(`标题: ${cv.title ?? "-"}`));
  console.log(c.dim(`模型: ${cv.provider}/${cv.model_id}   创建: ${ts(cv.created_at)}   最后活动: ${ts(cv.last_active_at)}`));
  console.log(c.dim(`cwd: ${cv.cwd ?? "-"}`));

  /* messages */
  const msgs = db
    .prepare(`SELECT id, turn_index, role, content, usage_input, usage_output, cost_usd, created_at
              FROM messages WHERE conversation_id = ? ORDER BY turn_index, created_at`)
    .all(convId);
  console.log(c.bold(`\n── 消息 (${msgs.length}) ──`));
  for (const m of msgs) {
    const tag =
      m.role === "user" ? c.cyan("user ") :
      m.role === "assistant" ? c.green("asst ") :
      m.role === "tool" ? c.yellow("tool ") : c.dim("sys  ");
    const usage =
      m.role === "assistant" && (m.usage_input || m.usage_output)
        ? c.dim(`  [in=${m.usage_input} out=${m.usage_output}]`)
        : m.role === "assistant"
          ? c.yellow("  [usage=0 —— 该条不是 Pi 直答,是合成的交接/提问确认]")
          : "";
    console.log(`  ${tag} t${m.turn_index} ${trunc(m.content, 90)}${usage}`);
  }

  /* artifacts */
  const { artifacts, rowCount, legacyOnly } = collectArtifacts(db, convId);
  console.log(c.bold(`\n── Blackboard artifacts (${artifacts.length},来自 ${rowCount} 行 blackboards) ──`));
  if (artifacts.length === 0) {
    console.log(
      c.yellow("  没有 artifact。") +
        (legacyOnly ? c.dim(" 注意:artifacts_json 为空 —— 若这轮 plan 根本没跑起来,查 decide→onTask 链路。") : ""),
    );
  }
  if (artifacts.length > 0) {
    console.log(
      c.dim("  提示:blackboards 的 goal/plan_json/todos_json 是遗留列,artifact 体系下恒为空,不代表没跑。"),
    );
  }
  for (const a of artifacts) {
    const icon = STATUS_ICON[a.status] ?? "?";
    const deps = a.dependsOn?.length ? c.dim(`  deps=[${a.dependsOn.join(",")}]`) : "";
    const err = a.metadata?.errorReason ? c.red(`  ${a.metadata.errorReason}`) : "";
    const truncFlag = a.metadata?.truncated ? c.yellow("  [truncated]") : "";
    console.log(`  ${icon} ${c.dim(a.id.padEnd(14))} ${a.kind.padEnd(9)} ${trunc(a.title, 52)}${deps}${err}${truncFlag}`);
  }

  /* 失败现场:note body 里存着原始 LLM 输出 */
  const notes = artifacts.filter((a) => a.kind === "note" && a.status === "resolved");
  if (notes.length) {
    console.log(c.bold(`\n── 失败现场(note body 保存着当时的原始输出) ──`));
    for (const n of notes) {
      console.log(c.yellow(`\n  ${n.id}  ${n.title}`));
      const related = (n.metadata?.relatedArtifacts ?? []).join(", ");
      if (related) console.log(c.dim(`  关联: ${related}`));
      // 这里是取证现场,不能截断 —— 截掉的部分往往正是关键(半截 JSON 在哪断的)。
      console.log(c.dim("  " + "-".repeat(70)));
      const lines = String(n.body ?? "").split("\n");
      for (const line of lines.slice(0, 40)) console.log(c.dim("  " + line));
      if (lines.length > 40) {
        console.log(c.dim(`  …(共 ${lines.length} 行,已显示前 40 行;完整内容用 sqlite3 或本脚本 -v 读取)`));
      }
    }
  }

  /* 已救回的截断产物 */
  const salvaged = artifacts.filter((a) => a.metadata?.truncated);
  if (salvaged.length) {
    console.log(c.bold(`\n── 被截断后救回的产物 (${salvaged.length}) ──`));
    console.log(c.dim("  这些内容不完整,下游综合时需注意。"));
    for (const a of salvaged) console.log(`  ${c.yellow("◑")} ${a.id} ${trunc(a.title, 50)}`);
  }

  /* bus */
  const busPath = join(DIR, "sessions", convId, "bus.jsonl");
  console.log(c.bold(`\n── MessageBus (${busPath.replace(DIR, "~")}) ──`));
  if (!existsSync(busPath)) {
    console.log(c.dim("  无 bus.jsonl"));
  } else {
    for (const line of readFileSync(busPath, "utf-8").trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const m = JSON.parse(line);
        console.log(
          `  ${c.dim(ts(m.ts))} ${c.cyan(m.fromRole)}→${c.cyan(m.toRole)} ` +
            `${c.dim(`[${m.context?.source ?? "?"}]`)} ${trunc(m.payload, 64)}`,
        );
      } catch {
        console.log(c.dim(`  [无法解析] ${trunc(line, 80)}`));
      }
    }
    console.log(c.dim("  注意:direction 字段形如 comm→user,但 toRole 才是真实收件人 —— 该字段有误导性,别信。"));
  }

  /* harness 管理面体检 */
  await harnessReport();
}

/* ──────────────────── harness 管理面体检(批次 7-G)──────────────────── */

/**
 * 7-G 起这一节体检的是**整个管理面**,不只是 3 个提示词文件。
 *
 * 关键设计:提示词单元元数据**从 dist 直读**(promptUnits.js 零运行时 import,
 * 是纯叶子模块),所以 diagnose 看到的单元表与生产/UI 看到的**是同一份**,
 * 不会出现「脚本里写死一份、代码里改了脚本不知道」。
 * dist 缺失或过期 → 降级成只报目录内容,并明确说降级了(不假装拿到了元数据)。
 */
async function loadPromptUnitMeta() {
  const dist = join(process.cwd(), "dist", "src", "server", "harness", "promptUnits.js");
  if (!existsSync(dist)) return null;
  try {
    const mod = await import(pathToFileURL(dist).href);
    if (!Array.isArray(mod.PROMPT_UNITS) || !mod.BUILTIN_PROMPTS) return null;
    return { units: mod.PROMPT_UNITS, builtins: mod.BUILTIN_PROMPTS };
  } catch {
    return null;
  }
}

function promptState(text, builtin) {
  if (!text.trim()) return "empty";
  if (builtin && text === builtin) return "factory";
  return "user_edited";
}

const STATE_LABEL = {
  factory: "出厂默认",
  user_edited: "用户手笔",
  empty: "空(回退内置)",
};

async function harnessReport() {
  const harnessDir = join(DIR, "harness");
  console.log(c.bold(`\n── Harness 管理面 (${harnessDir.replace(homedir(), "~")}) ──`));
  if (!existsSync(harnessDir)) {
    console.log(c.yellow("  目录不存在 —— 服务还没启动过,或数据目录不对。"));
    return;
  }

  const meta = await loadPromptUnitMeta();

  /* ── 面 1:提示词 ── */
  const promptsDir = join(harnessDir, "system_prompts");
  console.log(c.bold("\n  [prompts] 提示词单元"));
  if (!meta) {
    console.log(c.yellow("  ? 无法从 dist 读到单元注册表(promptUnits.js 缺失或过期)。"));
    console.log(c.dim("    先跑一次 npm run build;下面前面的检查仍按目录内容走。"));
  }
  const units = meta ? meta.units : null;
  if (units) {
    for (const u of units) {
      const p = join(promptsDir, `${u.id}.md`);
      let state, chars = 0;
      if (!existsSync(p)) {
        state = "empty";
      } else {
        const text = readFileSync(p, "utf-8");
        chars = text.length;
        state = promptState(text, meta.builtins[u.id]);
      }
      // orphan 优先:文件状态再正常,没人读就是没人读
      const label = u.enforced ? (STATE_LABEL[state] ?? state) : "无消费方(改了没用)";
      const icon = !u.enforced ? c.yellow("○") : state === "factory" ? c.green("✓") : state === "empty" ? c.yellow("?") : c.cyan("✎");
      console.log(`  ${icon} ${u.id.padEnd(22)} ${String(chars).padStart(6)} 字符  ${label}`);
      if (!u.enforced) console.log(c.dim(`      ↳ ${u.orphanReason}`));
      else if (state === "empty") console.log(c.dim(`      ↳ 正在用内置 ${u.id} 常量;改文件后 ${u.apply} 生效`));
    }
  } else if (existsSync(promptsDir)) {
    for (const f of readdirSync(promptsDir).filter((f) => f.endsWith(".md")).sort()) {
      const text = readFileSync(join(promptsDir, f), "utf-8");
      const thin = text.trim().length < 400;
      console.log(`  ${thin ? c.red("!") : c.green("✓")} ${f.padEnd(22)} ${String(text.length).padStart(6)} 字符${thin ? c.red("  ← 过于单薄,疑似 stub") : ""}`);
    }
  }

  /* ── 面 2:工具集合 ── */
  const toolsDir = join(harnessDir, "tools");
  console.log(c.bold("\n  [tools] 工具集合"));
  if (!existsSync(toolsDir)) {
    console.log(c.yellow("  ? 目录不存在 —— 7-E 起 server 启动会自动生成。"));
  } else {
    for (const f of readdirSync(toolsDir).filter((f) => f.endsWith(".json")).sort()) {
      let allowed = [], blocked = [];
      try {
        const j = JSON.parse(readFileSync(join(toolsDir, f), "utf-8"));
        allowed = Array.isArray(j.allow) ? j.allow : [];
        blocked = Array.isArray(j.deny) ? j.deny : [];
      } catch (e) {
        console.log(`  ${c.red("!")} ${f.padEnd(22)} ${c.red("JSON 解析失败 —— 解析器会回退出厂集合")}`);
        continue;
      }
      const tag = allowed.length > 0 ? c.green(allowed.join(" ")) : c.dim("空集合");
      console.log(`  ${allowed.length > 0 ? c.green("✓") : c.dim("○")} ${f.replace(/\.json$/, "").padEnd(22)} ${tag}${blocked.length ? c.dim(`  deny: ${blocked.join(" ")}`) : ""}`);
    }
  }

  /* ── 面 3/4:未实现,显式说明 ── */
  console.log(c.bold("\n  [skills] / [rag]"));
  console.log(c.dim("  ○ skills  未实现 —— src/ 里 skill 零命中;SDK 侧 loadSkills / formatSkillsForPrompt 已就绪。"));
  console.log(c.dim("  ○ rag     未实现管理面 —— 检索本身已在生产跑(ws.ts 每条消息 top-3 注入),"));
  console.log(c.dim("             但语料源/切分/embedding 模型(硬编码 text-embedding-3-small)/检索参数全写死。"));

  console.log(
    c.dim("\n  这些文件真的到达模型了吗?批次 7-B 之前 planner/executor 是死接线 ——\n" +
          "  orchestrator 只传 { storage },拿到的永远是模块内 stub。7-G 起的守卫:\n" +
          "  tests/agents/prompt-units.test.ts 会按 PROMPT_UNITS[].consumer 逐条\n" +
          "  打开 src/server/ 下的文件 grep 符号,找不到就红(写下当天就抓到 2 处错名)。"),
  );
}

/* ─────────────────────────── main ─────────────────────────── */

const argv = process.argv.slice(2);
if (argv.includes("--help") || argv.includes("-h")) {
  console.log(`
sansheng 诊断工具(只读)

  node scripts/diagnose.mjs                概览:所有会话 + 失败根因候选
  node scripts/diagnose.mjs <convId>       单会话全量诊断(含失败现场原文)
  node scripts/diagnose.mjs --harness      只看 harness 提示词体检

数据目录:优先 $SANSHENG_DATA,否则 ~/.sansheng
`);
  process.exit(0);
}

const db = open();
try {
  if (argv.includes("--harness")) {
    await harnessReport();
  } else if (argv.length > 0 && !argv[0].startsWith("-")) {
    detail(db, argv[0]);
  } else {
    overview(db);
  }
} finally {
  db.close();
}
