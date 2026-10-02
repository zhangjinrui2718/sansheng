import Database from "better-sqlite3";
// B3(审查 §B3):生产连接加载 sqlite-vec —— 此前全仓唯一 load 点在 tests/,
// 生产启动 002_vec.sql 永远被 skip,向量检索全链路死代码。
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "./migrations.js";
import { reconcileOrphanedRunArtifacts, BOOT_RECONCILE_REASON } from "./repo/blackboards.js";
import { log } from "../../shared/log.js";
import { existsSync, mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";

export interface StorageOptions {
  /**
   * B5(审查 §B5)× B8 协调:是否执行 boot 孤儿对账。**缺省 true = boot 语义**
   * (Storage 构造器是生产 boot 唯一的存储初始化点,此刻进程内必然零 active run)。
   *
   * `/api/reset` 在**同一进程内**重建 Storage 时必须显式传 `false`:
   * 那一刻库要么是 rm 成功后的全新空库(对账本就是 no-op),要么是 rm 失败的
   * 旧库(里面可能有本进程仍在跑的 run)—— 两种形态下「进程边界 = 孤儿」的
   * 判据都不成立,照搬构造器逻辑会把活 run 的 todo 误杀。详见 reopen()。
   */
  reconcileOrphans?: boolean;
  /**
   * B7:boot 后把 db / -wal / -shm 权限收紧到 0600。
   * 缺省 true。测试可用 :memory: 分支(不碰文件)天然绕过。
   */
  tightenPermissions?: boolean;
}

export class Storage {
  /**
   * B5:不再是 readonly —— reopen() 会在**同一 Storage 实例**上换一条连接。
   * 这是 reset 能做到「关闭并重建注入点」而不产生僵尸的关键:所有注入方
   * (http / ws / kernel / orchestrator / harness)持有的都是 Storage 实例,
   * 换连接对它们透明(它们每次都重新读 `storage.db`)。
   */
  db: Database.Database;
  /**
   * B3:本实例是否在构造时成功加载 sqlite-vec 扩展。
   * 仅文件路径构造分支会尝试加载;adopted-Database 分支(测试便利)恒 false —
   * 该分支的 vec 可用性由调用方负责(loadSqliteVec),运行时判定始终以
   * isVecAvailable(db) 为准(本标志只描述「构造器加载动作」的结果)。
   *
   * B5:reopen() 之后仍是**首次**构造时的值(诊断用);当前连接的 vec 可用性
   * 一律以 isVecAvailable(this.db) 为准。
   */
  readonly vecLoaded: boolean;
  /** B5:文件路径(仅文件分支有值);reopen 复用它。 */
  private readonly filePath: string | null;
  private closed = false;

  constructor(dbOrPath: string | Database.Database, opts: StorageOptions = {}) {
    if (typeof dbOrPath === "string") {
      this.filePath = dbOrPath;
      // 确保父目录存在
      const dir = dirname(dbOrPath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

      const opened = openDatabaseFile(dbOrPath, opts.tightenPermissions !== false);
      this.db = opened.db;
      this.vecLoaded = opened.vecLoaded;

      // B8(审查 §B8「重启/失败无对账:非终态 todo 永久悬挂」):boot 对账。
      // 接线点论证:Storage 构造是生产 boot 唯一的存储初始化点(index.ts:45),
      // 执行时刻在 HTTP listen / WS accept / kernel 接线之前 → 此刻进程内
      // 必然零 active run(协调层状态纯内存,重启全丢)→ 库中所有非终态
      // todo/intent 都是已死进程的孤儿,一次性终态化,零误杀(详见
      // reconcileOrphanedRunArtifacts 注释)。对账失败不阻塞 boot(warn 兜底)。
      if (opts.reconcileOrphans !== false) this.runBootReconcile();
    } else {
      // Adopt a caller-owned Database instance (test convenience for in-memory DBs).
      // The caller is responsible for running migrations and pragmas.
      this.db = dbOrPath;
      this.filePath = null;
      this.vecLoaded = false;
    }
  }

  /**
   * B5(审查 §B5「reset 改『关闭并重建注入点』」):在**同一实例**上重开存储。
   *
   * 旧 `/api/reset` 只 `close()` + 删文件,全仓再无 `new Storage(` → 除 health 外
   * 全部 API 500(use-after-close 被 try/catch 兜住),kernel 落库全失败,server 变僵尸。
   * 本方法让 reset 之后 server 立刻可用:句柄、migrations、权限收紧全部重跑一遍,
   * 而所有已注入 Storage **实例**的调用方(kernel/ws/http/orchestrator/harness)
   * 无需改动 —— 它们每次都从 `storage.db` 取连接。
   *
   * 调用契约:调用方负责在 reopen **之前**把数据文件删掉(本方法不删文件),
   * 并自行保证进程内的协调层状态已停(见 http.ts 的 reset 前置钩子)。
   *
   * 为什么默认不做 B8 孤儿对账(与构造器不同):
   *  1. rm 成功 → 全新空库,对账必然 no-op;
   *  2. rm 失败(权限/占用)→ 旧库原样,里面是**本进程仍在跑**的 run ——
   *     构造器那套「进程边界 = 孤儿」的判据在这里不成立,跑对账就是误杀活 run。
   * 因此调用方要显式传 `{ reconcile: true }` 才能开启(默认值即 false)。
   */
  reopen(opts: { reconcile?: boolean; tightenPermissions?: boolean } = {}): void {
    if (!this.filePath) {
      throw new Error("Storage.reopen: adopted-Database (in-memory) 实例没有文件路径,无法重开");
    }
    const previous = this.db;
    const opened = openDatabaseFile(this.filePath, opts.tightenPermissions !== false);
    this.db = opened.db;
    // 旧连接在新连接就位之后再关 —— 失败时至少不留两个写句柄。
    try {
      if (previous && previous.open) previous.close();
    } catch (err) {
      log.warn("storage reopen: closing previous connection failed:", err);
    }
    this.closed = false;
    if (opts.reconcile === true) this.runBootReconcile();
  }

  private runBootReconcile(): void {
    try {
      const reconciled = reconcileOrphanedRunArtifacts(this.db);
      if (reconciled.failedTodos > 0 || reconciled.failedIntents > 0) {
        log.warn(
          `storage: boot reconcile — failed ${reconciled.failedTodos} orphaned todo(s) + ${reconciled.failedIntents} non-terminal intent(s) left by a previous process (errorReason="${BOOT_RECONCILE_REASON}")`,
        );
      }
    } catch (err) {
      log.warn("storage: boot reconcile failed (continuing):", err);
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.close();
    } catch (err) {
      log.warn("storage close failed:", err);
    }
  }
}

/**
 * 打开(必要时新建)一个 SQLite 文件并完成标准初始化:pragma + sqlite-vec +
 * migrations + B7 权限收紧。构造与 reopen 共用,保证两条路径的库形态完全一致。
 */
function openDatabaseFile(
  dbPath: string,
  tightenPermissions: boolean,
): { db: Database.Database; vecLoaded: boolean } {
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  // B3:先加载扩展再跑 migrations —— 002(vec0 虚表)才能真实 applied;
  // 加载失败(平台二进制缺失/不支持平台)→ 降级不崩 boot:
  // 002 走 migrations 的 catch-and-skip(下次 boot 集合判定自动补跑),
  // repo 层经 isVecAvailable 探测回退 text/importance 检索。
  const vecLoaded = tryLoadVecExtension(db);

  const result = runMigrations(db);
  if (result.applied.length > 0) {
    log.info(`storage: applied migrations ${result.applied.join(", ")}`);
  }
  if (result.skipped.length > 0) {
    // B3:skip 不再完全静默 —— 明确告知降级项(002 会在 vec 可加载的下一次
    // boot 自愈补跑,见 migrations.ts 集合判定)
    log.warn(
      `storage: skipped migrations (degraded, will retry on next boot): ${result.skipped.join(", ")}`,
    );
  }
  // B1 additive safety: idempotently ensure blackboards.artifacts_json exists
  // (handles cases where migration 005 didn't run — e.g., legacy DBs upgraded in place).
  ensureBlackboardArtifactsColumn(db);

  if (tightenPermissions) tightenDbFilePermissions(dbPath);

  return { db, vecLoaded };
}

/**
 * B7(审查 §B7「sansheng.db/-wal/-shm 实测 0644」):把数据文件权限收紧到 0600。
 *
 * 威胁模型见 docs/SECURITY-NOTES.md。一句话:同一台机器上的**其他用户**
 * 不应能读到全部会话与记忆。
 * - 主库:直接 chmod(SQLite 以 db 文件的权限位创建 WAL/SHM,所以新建的
 *   -wal/-shm 会自动继承 0600);
 * - -wal/-shm:历史遗留形态可能还是 0644,单独再 chmod 一次(best-effort,
 *   文件不存在时忽略);也覆盖「先有 db 后开 WAL」的存量形态。
 * - 失败不阻塞 boot:权限收紧是纵深防御,不是功能前提。
 */
export function tightenDbFilePermissions(dbPath: string): void {
  for (const p of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
    try {
      if (!existsSync(p)) continue;
      chmodSync(p, 0o600);
    } catch (err) {
      log.warn(`storage: chmod 0600 failed for ${p} (continuing):`, err);
    }
  }
}

/**
 * B3(审查 §B3 修复方向「db.ts 构造器 try/catch load」):
 * 在连接上加载 sqlite-vec 扩展。失败 → warn + 返回 false(降级语义):
 *  - 002_vec.sql 由 runMigrations 的 vec0 catch-and-skip 兜住,boot 不崩;
 *  - fragments repo 经 isVecAvailable 探测自动走 text/importance fallback;
 *  - 下一次 boot(vec 可加载时)由集合判定自动补跑 002(自愈)。
 * sqlite-vec 的平台二进制是 optionalDependencies:装不上时 load() throw,
 * 这正是必须 try/catch 的原因(包本体在 dependencies,顶层 import 安全)。
 */
function tryLoadVecExtension(db: Database.Database): boolean {
  try {
    loadSqliteVec(db);
    return true;
  } catch (err) {
    log.warn(
      "storage: sqlite-vec extension load failed — vector search degraded to text/importance fallback:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

/**
 * B1 · ensure `blackboards.artifacts_json` column exists.
 *
 * Idempotent — safe to call multiple times. Uses PRAGMA table_info to detect
 * the column, then ALTER TABLE if missing. Default `'[]'` matches migration 005.
 *
 * This complements migration 005 for:
 *   - DBs created on older migrations where 005 didn't run yet
 *   - In-memory test DBs that skip the full migration runner
 *   - Recovery scenarios where a row needs the column added
 */
export function ensureBlackboardArtifactsColumn(db: Database.Database): void {
  // PRAGMA table_info on a missing table throws. Guard so callers (e.g. fresh
  // DB before migrations ran) don't crash — it's purely a defense-in-depth
  // check; the column is normally added by migration 005.
  const tables = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='blackboards'`)
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return;
  const cols = db
    .prepare(`PRAGMA table_info(blackboards)`)
    .all() as Array<{ name: string }>;
  const has = cols.some((c) => c.name === "artifacts_json");
  if (has) return;
  db.exec(`ALTER TABLE blackboards ADD COLUMN artifacts_json TEXT DEFAULT '[]'`);
}