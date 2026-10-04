/**
 * Sansheng 平台 · 存储层连接
 *
 * 与 `src/server/storage/db.ts`(旧系统)是**两个独立的连接工厂**,但指向
 * 同一个 SQLite 文件、跑同一份 `migrations/` 目录 —— 因为新表是并存而非替换
 * (migrations/007 只做加法,见该文件头)。
 *
 * ⚠️ **临时依赖**:这里从旧 server 导入 `runMigrations`。迁移器本身是通用基础
 * 设施(按编号跑 .sql + `schema_version` 集合判定),不属于任何一侧的领域逻辑,
 * 放在旧侧只是因为它先建在那里。当 `src/server/**` 进入删除阶段时,把它整体
 * 搬到 `src/platform/storage/migrations.ts` 即可 —— 这个 import 会**编译失败**,
 * 于是搬迁时机是响亮的而不是靠人记得。
 */
import Database from "better-sqlite3";
import { load as loadSqliteVec } from "sqlite-vec";
import { runMigrations } from "../infra/migrations.js";

export interface OpenPlatformDbOptions {
  /** 覆盖 migrations 目录(测试 seam)。缺省 = 仓库根的 migrations/ */
  migrationsDir?: string;
  /** 是否打开 WAL。内存库不需要。 */
  wal?: boolean;
}

/**
 * 打开一个平台库并完成标准初始化:pragma + migrations。
 *
 * ── pragma ──────────────────────────────────────────────────────
 *   journal_mode = WAL     并发读写(SQLite 默认 rollback journal 写会阻塞读)
 *   foreign_keys = ON      **必须显式开** —— SQLite 默认 OFF,不开则 007 里
 *                          全部 REFERENCES 形同虚设
 *   busy_timeout = 5000    多连接(新旧并存期会有两个)时给锁留重试窗口
 *   synchronous = NORMAL   WAL 下的推荐档
 *
 * ── 为什么仍然加载 sqlite-vec ────────────────────────────────────
 *
 * 平台自己**不用**向量检索(设计 1 §8.3 已把整条链路划为删除项)。但新旧共用
 * 同一个 SQLite 文件与同一份迁移历史,而迁移 002 建的是 vec0 虚表 —— 不加载
 * 扩展它就永远应用不上,于是迁移器每次 boot 都警告「002 被跳过,下次重试」。
 * **那句话在平台路径上是假的**:它永远不会成功。
 *
 * 所以这里是 parity 而非功能:加载失败照旧降级(与旧侧一致),成功则 002 正常
 * 应用、日志不再说谎。等阶段 8 把 002 与 `fragments_vec` 一起删掉时,这个
 * import 一并消失。
 */
export function openPlatformDb(
  path: string,
  opts: OpenPlatformDbOptions = {},
): Database.Database {
  const db = new Database(path);

  if (opts.wal !== false) db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");

  try {
    loadSqliteVec(db);
  } catch {
    // 降级不崩:002 会被迁移器 skip,旧侧同样如此。平台自身不需要向量能力。
  }

  runMigrations(db, opts.migrationsDir !== undefined ? { migrationsDir: opts.migrationsDir } : {});
  return db;
}

/** 内存库,给测试用。不走 WAL(内存库无意义)。 */
export function openPlatformMemoryDb(opts: { migrationsDir?: string } = {}): Database.Database {
  return openPlatformDb(":memory:", {
    wal: false,
    ...(opts.migrationsDir !== undefined ? { migrationsDir: opts.migrationsDir } : {}),
  });
}
