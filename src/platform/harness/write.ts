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
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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

/** 一次 seed 的结果。四个桶,调用方必须**逐个**处理,不能只看 seeded。 */
export interface SeedResult {
  /** 本次从出厂副本落盘的单元 id。 */
  readonly seeded: readonly string[];
  /** 落盘前就已存在、**原样未动**的单元 id。 */
  readonly alreadyPresent: readonly string[];
  /** 出厂副本不存在的单元 id(该单元保持「未装载」,等用户手点恢复出厂)。 */
  readonly factoryMissing: readonly string[];
  /** 出厂副本在,但落盘失败的单元(形如 `id(原因)`)。 */
  readonly failed: readonly string[];
}

/**
 * 启动时 seed:把**缺失**的提示词单元从出厂副本补到 dataDir。
 *
 * ── 只补缺失,绝不覆盖 ────────────────────────────────────────────
 *
 * 这一条是本函数存在的全部理由,也是它与 `resetPromptUnit` 的**语义分界**:
 *
 *   · **恢复出厂**(用户点按钮)—— 用户的**显式指令**,意图就是「我不要我改的
 *     这份了,换回默认」。所以它**覆盖**,而且覆盖前先备份(规矩②)。
 *   · **启动 seed**(用户什么都没干)—— 系统的**静默兜底**,意图只是
 *     「别让新装的 agent 少一条规矩」。它**只填空缺**。
 *
 * 把 seed 写成覆盖(例如直接调 `resetPromptUnit` 走一遍)会静默吃掉用户编辑:
 * 用户精心改过的提示词在**下次重启**后变回默认,而界面上没有任何东西提示过他 ——
 * 用户唯一的发现方式是「我明明改过,怎么又回来了」。
 * 这与「恢复出厂」在 agent 侧的效果同样致命(它确实生效了),但它是**静默**的,
 * 所以更难查。**覆盖必须永远是用户亲手点的那个动作。**
 *
 * ── 幂等 ──────────────────────────────────────────────────────────
 *
 * 纯「存在性检查 + 补写」,无备份、无临时文件、无计数器。第二次启动
 * 全部落在 `alreadyPresent`,一次也不写。所以重启/反复 `platform-serve`
 * 不会污染 dataDir,也不会产生备份堆积。
 *
 * ── 失败不许静默,也不许拦住启动 ────────────────────────────────────
 *
 * 出厂副本缺失(构建漏拷 `copy-harness.mjs`)对**某一个**单元不是致命的:
 * 其余 13 个照常落盘,这个单元退回 `loaded: false`,agent 少一条规矩但照常跑。
 * 所以这里返回分桶结果而不是抛异常 —— 是否警告由调用方决定,
 * 但结果必须让它**有能力**如实报告。
 */
export function seedPromptUnits(dirs: FactoryDirs): SeedResult {
  const seeded: string[] = [];
  const alreadyPresent: string[] = [];
  const factoryMissing: string[] = [];
  const failed: string[] = [];

  for (const unitId of promptUnitIds()) {
    const target = unitFilePath(dirs, unitId);

    // 在位 ⇒ 一个字节都不碰。这是「不覆盖」的全部实现,没有例外分支。
    if (existsSync(target)) {
      alreadyPresent.push(unitId);
      continue;
    }

    const factory = join(dirs.factoryDir, `${unitId}.md`);
    if (!existsSync(factory)) {
      factoryMissing.push(unitId);
      continue;
    }

    try {
      // 用 copyFileSync 而不是 writePromptUnit:后者是「用户写」的语义
      // (备份 + 回读校验),seed 不是用户写,不该在那条路上留下备份痕迹。
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(factory, target);
      seeded.push(unitId);
    } catch (err) {
      // 与 factoryMissing 分开记 —— 报成「出厂副本缺失」会掩盖真实原因
      // (比如 dataDir 不可写),调用方就会对着错误的方向去排查。
      failed.push(`${unitId}(${err instanceof Error ? err.message : String(err)})`);
    }
  }

  return { seeded, alreadyPresent, factoryMissing, failed };
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
