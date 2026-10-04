/**
 * Harness 写面 · 提示词单元
 *
 * ── 四条规矩(全部来自旧系统 7-O 的真实教训,一条都不能省)──────────
 *
 * **① id 必须来自闭合注册表。**
 * 先查表再拼路径 —— 这是唯一挡路径穿越的地方。`unitId` 直接进文件名,
 * 一个 `../../settings.json` 就能写到数据目录外面去。
 * 注册表就是 `ROLE_SPECS[*].promptUnits`,不接受任何别处的 id。
 *
 * **② 备份是写的前置。**
 * 覆盖前先落 `.bak`,**备份失败就不写**。用户改提示词改坏了、想回退,
 * 没有备份就只能凭记忆重写。
 *
 * **③ 报成功 = 真生效。**
 * 返回的正文是**回读**那份,不是内存里的入参。旧系统在这条上栽过:
 * 返回 200 而磁盘没变,用户以为改了。
 *
 * **④ 恢复出厂 ≠ 删文件。**
 * 删文件 = empty 态(`loaded: false`,agent 不知道那条规矩了);
 * 写回出厂字节 = default 态。两者对 agent 的行为影响完全不同。
 * 所以需要**出厂副本** —— 构建时从仓库 `harness/` 拷进 `dist/harness/`。
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_SPECS, PROJECT_ROLES } from "../identity/role.js";

/** 备份保留份数(与旧系统 7-O 同:留最近 10 份)。 */
const KEEP_BACKUPS = 10;

export interface WriteResult {
  readonly ok: boolean;
  readonly reason?: "unknown_unit" | "backup_failed" | "write_failed" | "no_factory_copy";
  readonly detail?: string;
  /** **回读**到的正文(规矩③) */
  readonly content?: string;
  readonly backupPath?: string;
}

export interface FactoryDirs {
  /** 运行时数据目录(`<dataDir>/harness/system_prompts`) */
  readonly dataDir: string;
  /**
   * 出厂副本目录。构建时从仓库 `harness/system_prompts/` 拷到 `dist/harness/system_prompts/`。
   * 找不到时「恢复出厂」会如实报错,而不是删文件假装恢复。
   */
  readonly factoryDir: string;
}

/**
 * 闭合注册表:所有合法的提示词单元 id。
 *
 * **由 ROLE_SPECS 推导,不是另写一份清单** —— 另写一份就会漂,
 * 而漂的表现是「某个单元永远改不了」或「某个 id 能穿出去」。
 */
export function promptUnitIds(): readonly string[] {
  const ids = new Set<string>();
  for (const role of PROJECT_ROLES) {
    for (const u of ROLE_SPECS[role].promptUnits as readonly string[]) ids.add(u);
  }
  return [...ids].sort();
}

/** 该 id 是否属于某个角色(用于错误信息,让用户知道这个 id 是给谁用的)。 */
export function rolesForUnit(unitId: string): string[] {
  // promptUnits 是闭合字面量联合的数组,而这里要比对的是运行期的 string ——
  // 先放宽成 string[] 再 includes,避免为了比对造一个假的字面量类型
  return PROJECT_ROLES.filter((r) =>
    (ROLE_SPECS[r].promptUnits as readonly string[]).includes(unitId),
  );
}

export function unitFilePath(dirs: FactoryDirs, unitId: string): string {
  return join(dirs.dataDir, "harness", "system_prompts", `${unitId}.md`);
}

function backupDir(dataDir: string): string {
  return join(dataDir, "harness", "backups", "prompts");
}

/**
 * 落一份备份。
 *
 * 三种返回值,调用方必须区分:
 *   - `string`    —— 备份成功,路径在这
 *   - `undefined` —— **没有东西可备份**(首次创建该单元),不是失败
 *   - `null`      —— 备份**失败**,调用方必须拒绝写入(规矩②)
 */
function backup(dirs: FactoryDirs, unitId: string, now: number): string | null | undefined {
  const src = unitFilePath(dirs, unitId);
  // 首次创建(还没有用户文件)时没有东西可备份 —— 那不是失败
  if (!existsSync(src)) return undefined;

  const dir = backupDir(dirs.dataDir);
  try {
    mkdirSync(dir, { recursive: true });
    // 同毫秒撞名要避让:加序号直到没有冲突
    let target = join(dir, `${unitId}.${now}.bak`);
    let n = 1;
    while (existsSync(target)) target = join(dir, `${unitId}.${now}.${n++}.bak`);
    // 用 copyFileSync 语义(读+写)而不是 rename —— rename 会把源文件移走
    writeFileSync(target, readFileSync(src));
    pruneBackups(dirs.dataDir, unitId);
    return target;
  } catch {
    return null;
  }
}

/** 只留最近 KEEP_BACKUPS 份。失败不影响主流程(备份已经落下了)。 */
function pruneBackups(dataDir: string, unitId: string): void {
  try {
    const dir = backupDir(dataDir);
    const mine = readdirSync(dir)
      .filter((f) => f.startsWith(`${unitId}.`) && f.endsWith(".bak"))
      .sort(); // 文件名里带时间戳 → 字典序即时间序
    for (const old of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
      rmSync(join(dir, old), { force: true });
    }
  } catch {
    /* 清理失败不影响写入 */
  }
}

/**
 * 写一个提示词单元。
 *
 * 顺序:**校验 id → 备份 → 原子写 → 回读**。任何一步失败都不留下半成品。
 */
export function writePromptUnit(
  dirs: FactoryDirs,
  unitId: string,
  content: string,
  now: number,
): WriteResult {
  // ① 闭合注册表 —— 唯一的路径穿越防线
  if (!promptUnitIds().includes(unitId)) {
    return { ok: false, reason: "unknown_unit", detail: `未知单元 id「${unitId}」` };
  }

  // ② 备份是写的前置
  const src = unitFilePath(dirs, unitId);
  const existed = existsSync(src);
  let backupPath: string | undefined;
  if (existed) {
    const b = backup(dirs, unitId, now);
    if (b === null) {
      return {
        ok: false,
        reason: "backup_failed",
        detail: "备份失败,已中止写入(不留没有退路的修改)",
      };
    }
    backupPath = b;
  }

  // 原子写:先写临时文件再 rename,避免「写到一半断电」留下半份提示词
  const target = unitFilePath(dirs, unitId);
  const tmp = `${target}.tmp`;
  try {
    mkdirSync(join(dirs.dataDir, "harness", "system_prompts"), { recursive: true });
    writeFileSync(tmp, content, "utf8");
    renameSync(tmp, target);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      /* 清理失败无所谓 */
    }
    return { ok: false, reason: "write_failed", detail: err instanceof Error ? err.message : String(err) };
  }

  // ③ 回读 —— 报成功 = 真生效
  let readBack: string;
  try {
    readBack = readFileSync(target, "utf8");
  } catch (err) {
    return {
      ok: false,
      reason: "write_failed",
      detail: `写后回读失败:${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (readBack !== content) {
    return { ok: false, reason: "write_failed", detail: "写后回读的内容与提交的不一致" };
  }

  return { ok: true, content: readBack, ...(backupPath !== undefined ? { backupPath } : {}) };
}

/**
 * 恢复出厂(规矩④)。
 *
 * **写回出厂字节,不是删文件。** 删文件会让该单元变成 `loaded: false` ——
 * agent 从此不知道那条规矩,而这与「恢复默认」是完全不同的两件事。
 */
export function resetPromptUnit(dirs: FactoryDirs, unitId: string, now: number): WriteResult {
  if (!promptUnitIds().includes(unitId)) {
    return { ok: false, reason: "unknown_unit", detail: `未知单元 id「${unitId}」` };
  }
  const factory = join(dirs.factoryDir, `${unitId}.md`);
  if (!existsSync(factory)) {
    return {
      ok: false,
      reason: "no_factory_copy",
      detail:
        `找不到出厂副本(${factory})—— 无法恢复出厂。` +
        `删掉用户文件只会让它变成「未装载」,那不是恢复默认。`,
    };
  }
  let bytes: string;
  try {
    bytes = readFileSync(factory, "utf8");
  } catch (err) {
    return { ok: false, reason: "no_factory_copy", detail: err instanceof Error ? err.message : String(err) };
  }
  return writePromptUnit(dirs, unitId, bytes, now);
}

/** 列出某个单元的历史备份(新的在前)。 */
export function listBackups(
  dataDir: string,
  unitId: string,
): Array<{ file: string; path: string }> {
  try {
    const dir = backupDir(dataDir);
    return readdirSync(dir)
      .filter((f) => f.startsWith(`${unitId}.`) && f.endsWith(".bak"))
      .sort()
      .reverse()
      .map((f) => ({ file: f, path: join(dir, f) }));
  } catch {
    return [];
  }
}
