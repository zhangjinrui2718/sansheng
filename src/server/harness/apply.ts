/**
 * Sansheng Harness · 写层(apply)
 *
 * 批次 7-O。facet.ts:38-40 在 7-G 定下了一条规矩:「apply() 不在 v1 —— 先把只读
 * 面做对、把『在生效』变成可验证的断言,再谈写」,并给出了写面的形状:
 * 「独立的 `applyFacet()` + 备份 + 显式确认」。本文件就是那个「独立」的写层,
 * 它守着 7-O 要兑现的五条断言:
 *
 *   1. **写之前必须先备份。** 覆盖用户手笔之前把原字节复制到
 *      `harness/backups/<facet>/<id>.<时间戳>.bak`,只保留最近 10 份。
 *      备份是**覆盖旧内容的前提**,不是善后 —— 备份失败就不写。
 *   2. **原子替换。** 先写同目录临时文件、回读校验字节一致,再 rename。
 *      任何一步失败都清掉临时文件并报 io_error —— 报告里绝不能出现
 *      「失败了但文件已经被改了一半」。
 *   3. **id 来自闭合注册表,绝不拼路径。** unit ∈ PROMPT_UNIT_IDS、
 *      role ∈ TOOL_ROLES 都是先查表再落盘;「../」这类输入连查表都过不去。
 *      这是写面唯一能挡路径穿越的地方,HTTP 层只负责把错误码翻译成 4xx。
 *   4. **权限面 fail-closed 不因写接口而放松。** 工具名不认识 → 400 拒收
 *      (注意:**不**是「静默丢掉」—— 静默丢掉是读盘解析器的义务,写接口收到
 *      不认识的名字说明调用方写错了,必须让它知道);名字认识但在 ROLE_CEILING
 *      之外 → **照写**,但落进 blockedByCeiling 并带一条告警返回给 UI。
 *      集合文件突破不了架构上界,这条从 7-E 起没变过。
 *   5. **报成功 = 真生效。** 返回的 `content` 是**回读**结果,不是内存里那份;
 *      改完之后各面用自己的 describe() 现算一条 HarnessEntry 附在结果里,
 *      UI 拿到的 state / allowed / blockedByCeiling 全部来自重新读盘。
 *      「写完说有新状态、其实没落盘」是本项目最反噬的一种假实现。
 *
 * 恢复出厂(reset)与普通写入走**同一条路径**:只是目标字节换成
 * BUILTIN_PROMPTS[unit] / factoryToolSetFileContent(role)。
 * 之所以是「恢复出厂」而不是「删除文件」:文件缺失在 loader 语义里等于
 * 「空串 → 消费方回退到内置常量」,而 state 会变成 empty —— 看起来像用户把
 * 手册清空了,实际上「删文件」和「恢复出厂」是两件事,用户要的通常是后者。
 *
 * 不在这里做(留给各面):把 RawApplyResult 翻译成 HarnessApplyResult、
 * 决定「生效时机」那句话怎么写、以及要不要触发 kernel.invalidate()
 * (那是 HTTP 层的副作用决策,不属于写盘)。
 */
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { log } from "../../shared/log.js";
import { promptFilePath } from "./loader.js";
import {
  BUILTIN_PROMPTS,
  PROMPT_UNIT_IDS,
  type PromptUnitId,
} from "./promptUnits.js";
import {
  TOOL_NAMES,
  TOOL_ROLES,
  factoryToolSetFileContent,
  roleToolCeiling,
  toolSetFileContent,
  toolSetFilePath,
  type ToolName,
  type ToolRole,
  type ToolSetFile,
} from "./tools.js";
import type { ApplyErrorCode, RawApplyResult } from "./facetTypes.js";

/**
 * 提示词写入上限。当前出厂最长的 executor.md 约 5 KB,128 KiB 是「用户粘贴了
 * 一整份手册进来」与「手滑贴了个二进制文件」之间的分界。**超限一律 400 拒收**,
 * 不做静默截断 —— 截断出来的提示词会变成一个语法完整、语义残缺的模型输入。
 */
export const MAX_PROMPT_CHARS = 128 * 1024;

/** 每个条目保留的备份份数。够回退最近 10 次,又不会把 dataDir 撑爆。 */
const BACKUP_KEEP = 10;

/* ── module-level type guards(项目纪律:不许 as any)─────────────────────── */

/** 导出给 facet 层做收窄(apply 成功即证明 id 合法,facet 仍需自己收窄才能拿到 `PromptUnitId`)。 */
export function isPromptUnitId(v: string): v is PromptUnitId {
  return (PROMPT_UNIT_IDS as readonly string[]).includes(v);
}

/** 同上,tools 面用。 */
export function isToolRole(v: string): v is ToolRole {
  return (TOOL_ROLES as readonly string[]).includes(v);
}

function isToolName(v: string): v is ToolName {
  return (TOOL_NAMES as readonly string[]).includes(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function fail(error: ApplyErrorCode, message: string, details?: unknown): RawApplyResult {
  return { ok: false, error, message, ...(details !== undefined ? { details } : {}) };
}

/* ── 备份 ──────────────────────────────────────────────────────────────── */

/** `20261003-154233-118` —— 排序即时间序,裁剪时不用 stat。 */
function timestamp(): string {
  const d = new Date();
  const pad = (n: number, w = 2): string => String(n).padStart(w, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}` +
    `-${pad(d.getMilliseconds(), 3)}`
  );
}

/**
 * 覆盖前把 filePath 的当前内容备份到 `harness/backups/<facet>/`。
 * 文件不存在 → 返回 null(没有可丢的东西,如首次写入)。
 * 备份失败 → **抛**(调用方据此中止写入):备份是写的前置,不是写后的补救。
 */
function backupExisting(dataDir: string, facet: string, id: string, filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  const dir = join(dataDir, "harness", "backups", facet);
  mkdirSync(dir, { recursive: true });
  // 同一毫秒里的连续写入(批量测试、脚本连改)会撞名 —— 撞名就丢备份,
  // 而「备份丢了」是那种事后无法察觉的静默损坏,所以这里显式避让。
  let name = `${id}.${timestamp()}.bak`;
  let bump = 2;
  while (existsSync(join(dir, name))) {
    name = `${id}.${timestamp()}-${bump}.bak`;
    bump += 1;
  }
  const dest = join(dir, name);
  writeFileSync(dest, readFileSync(filePath), "utf-8");
  // 裁剪:同一条目只留最近 BACKUP_KEEP 份。文件名以 `<id>.` 开头 + 按序排,
  // 所以过滤条件不会碰到别的条目 / 别的面。
  const mine = readdirSync(dir)
    .filter((f) => f.startsWith(`${id}.`) && f.endsWith(".bak"))
    .sort();
  for (const stale of mine.slice(0, Math.max(0, mine.length - BACKUP_KEEP))) {
    try {
      unlinkSync(join(dir, stale));
    } catch (err) {
      // 裁剪失败不是致命错误:备份本身已经落盘了,如实记一条即可
      log.warn(`harness: 备份裁剪失败(保留旧文件):${stale} — ${(err as Error).message}`);
    }
  }
  return dest;
}

/* ── 原子写 ────────────────────────────────────────────────────────────── */

/**
 * 原子替换:临时文件 → 回读校验 → rename。
 * 校验失败也当作失败(而不是「大概写进去了」):磁盘满、部分写入、编码转换都可能
 * 让落盘字节与预期不同,而提示词文件少一个字节就是模型少一条约束。
 */
function writeFileAtomic(filePath: string, content: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now().toString(36)}`;
  try {
    writeFileSync(tmp, content, "utf-8");
    const readback = readFileSync(tmp, "utf-8");
    if (readback !== content) {
      throw new Error(
        `回读校验不一致(写入 ${content.length} 字符,读回 ${readback.length} 字符)`,
      );
    }
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // 临时文件删不掉不是本次失败的原因,原样抛出真原因
    }
    throw err;
  }
}

/**
 * 备份 + 原子写 + 回读。**幂等**:目标内容与现状一致时什么都不做
 * (changed=false,无备份)。UI 上的「保存」在没改内容时不该产生一份垃圾备份。
 */
function commit(
  dataDir: string,
  facet: string,
  id: string,
  filePath: string,
  content: string,
  warnings: string[],
): RawApplyResult {
  let existing: string | null = null;
  if (existsSync(filePath)) {
    try {
      existing = readFileSync(filePath, "utf-8");
    } catch (err) {
      return fail("io_error", `覆盖前读取 ${filePath} 失败,未改动任何文件: ${(err as Error).message}`);
    }
  }
  if (existing === content) {
    return { ok: true, changed: false, backupPath: null, filePath, warnings, content };
  }
  let backupPath: string | null = null;
  try {
    backupPath = backupExisting(dataDir, facet, id, filePath);
    writeFileAtomic(filePath, content);
  } catch (err) {
    return fail("io_error", `写入 ${filePath} 失败,未改动任何文件: ${(err as Error).message}`);
  }
  const after = readFileSync(filePath, "utf-8");
  log.info(`harness: 写入 ${facet}/${id} ${existing === null ? "(新建)" : "(覆盖)"}${backupPath ? `,备份 ${backupPath}` : ""}`);
  return { ok: true, changed: true, backupPath, filePath, warnings, content: after };
}

/* ── prompts 面 ────────────────────────────────────────────────────────── */

/**
 * 写入一个提示词单元。reset=true 时忽略 content,写回出厂默认。
 *
 * 空内容是**合法输入**(state=empty = 消费方回退到内置常量),但必须带一条告警:
 * 用户很可能只是想清两行,结果把整份手册清空了。写面不做「猜测意图」的拦截
 * (那是模型的活),但一定要把后果说出来。
 */
export function applyPromptUnit(
  dataDir: string,
  unitRaw: string,
  content: unknown,
  reset: boolean,
): RawApplyResult {
  if (!isPromptUnitId(unitRaw)) {
    return fail(
      "unknown_entry",
      `提示词单元「${unitRaw}」不在注册表内(合法 id:${PROMPT_UNIT_IDS.join(" / ")})`,
    );
  }
  const unit = unitRaw;
  let text: string;
  const warnings: string[] = [];
  if (reset) {
    text = BUILTIN_PROMPTS[unit];
  } else {
    if (typeof content !== "string") {
      return fail("invalid_payload", `content 必须是字符串(实际 ${content === null ? "null" : typeof content})`);
    }
    if (content.length > MAX_PROMPT_CHARS) {
      return fail(
        "invalid_payload",
        `内容 ${content.length} 字符,超过上限 ${MAX_PROMPT_CHARS}`,
      );
    }
    text = content;
    if (!text.trim()) {
      warnings.push(
        "写入的是空内容 —— 该单元会退回内置常量(state=empty)。想「删掉这个提示词」和「恢复出厂默认」是两件事,后者请用「恢复出厂」。",
      );
    }
  }
  return commit(dataDir, "prompts", unit, promptFilePath(dataDir, unit), text, warnings);
}

/* ── tools 面 ──────────────────────────────────────────────────────────── */

/** 收 allow / deny 数组:去重、保持顺序、认识的名字全收。 */
function normalizeNames(raw: unknown, field: string): { names: ToolName[]; bad: string[] } {
  if (raw === undefined) return { names: [], bad: [] };
  if (!Array.isArray(raw)) {
    return { names: [], bad: [`${field} 不是数组(实际 ${raw === null ? "null" : typeof raw})`] };
  }
  const names: ToolName[] = [];
  const bad: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      bad.push(String(item));
      continue;
    }
    if (!isToolName(item)) {
      bad.push(item);
      continue;
    }
    if (!names.includes(item)) names.push(item);
  }
  return { names, bad };
}

/**
 * 写入某个角色的工具集合。reset=true 时忽略 payload,写回出厂集合。
 *
 * 与读路径的容错策略**刻意相反**,值得单独说明:
 *   · 读路径(parseToolSetFile)遇到不认识的名字 → 丢掉 + 告警。因为文件可能是
 *     老版本、可能手改坏了,读取端必须能带着降级结果继续跑。
 *   · 写路径收到不认识的名字 → **400 拒收**。调用方(UI / curl)刚刚亲手写下这个
 *     名字,静默丢掉等于让用户以为「我给了执行者 net_post 它就有了」——
 *     这正是 7-E 把 blockedByCeiling 画出来要防的那类假象。
 *   · 但「认识、却在本角色上界之外」的名字 → **照写**。上界是架构裁决,
 *     集合文件可以写、只是解析时会被挡住;把这个事实原样写进文件、让
 *     blockedByCeiling 长期显示着,比在写接口偷偷过滤更诚实。
 */
export function applyToolSet(
  dataDir: string,
  roleRaw: string,
  payload: unknown,
  reset: boolean,
): RawApplyResult {
  if (!isToolRole(roleRaw)) {
    return fail(
      "unknown_entry",
      `角色「${roleRaw}」不在工具集合注册表内(合法 id:${TOOL_ROLES.join(" / ")})`,
    );
  }
  const role = roleRaw;
  const filePath = toolSetFilePath(dataDir, role);
  if (reset) {
    return commit(dataDir, "tools", role, filePath, factoryToolSetFileContent(role), [
      "已恢复出厂集合 —— 若该角色当前无工具执行点(enforced=false),恢复出厂等于恢复成空集合。",
    ]);
  }
  if (!isRecord(payload)) {
    return fail("invalid_payload", `body 必须是 JSON 对象 { allow, deny }(实际 ${payload === null ? "null" : typeof payload})`);
  }
  const allow = normalizeNames(payload["allow"], "allow");
  const deny = normalizeNames(payload["deny"], "deny");
  if (allow.bad.length > 0 || deny.bad.length > 0) {
    return fail(
      "invalid_payload",
      `未改动任何文件。以下名字不在工具闭合联合内:${[...allow.bad, ...deny.bad].map((b) => `「${b}」`).join("、")}。合法工具:${TOOL_NAMES.join(" / ")}`,
      { unknown: [...allow.bad, ...deny.bad], legal: TOOL_NAMES },
    );
  }
  const warnings: string[] = [];
  const ceiling = roleToolCeiling(role);
  const outside = allow.names.filter((t) => !ceiling.includes(t));
  if (outside.length > 0) {
    warnings.push(
      `${outside.map((t) => `「${t}」`).join("、")} 超出 ${role} 的架构上界,已写入文件但**不会生效**(blockedByCeiling)—— 放开上界是改 ROLE_CEILING 的代码动作,不是改集合文件。`,
    );
  }
  const deniedOutside = deny.names.filter((t) => !ceiling.includes(t));
  if (deniedOutside.length > 0) {
    warnings.push(
      `deny 里的 ${deniedOutside.map((t) => `「${t}」`).join("、")} 本来就不在 ${role} 的上界内,不会有任何效果。`,
    );
  }
  const conflict = allow.names.filter((t) => deny.names.includes(t));
  if (conflict.length > 0) {
    warnings.push(
      `allow 与 deny 同时包含 ${conflict.map((t) => `「${t}」`).join("、")} —— deny 胜出,这些工具不会生效。`,
    );
  }
  const file: ToolSetFile = { allow: allow.names, deny: deny.names };
  return commit(dataDir, "tools", role, filePath, toolSetFileContent(file), warnings);
}
