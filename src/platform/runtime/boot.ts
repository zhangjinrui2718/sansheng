/**
 * 平台运行时 · 启动装配
 *
 * ── 它做什么 ────────────────────────────────────────────────────
 *
 * 把「一个能跑的平台」需要的四样东西拼起来:
 *   1. 设置读取(provider / model / 工作目录)
 *   2. 模型解析
 *   3. 平台库打开(migrations 在新库上跑一遍)
 *   4. RuntimeDeps 组装(db + 记忆端口 + 时钟 + id)
 *
 * ── 为什么它借用旧 server 的两个模块 ──────────────────────────────
 *
 * `SettingsStore` / `Keyring` / `resolveModel` 是**基础设施**,不是旧系统的领域
 * 逻辑 —— 它们管的是「provider 配在哪、key 怎么存、模型怎么解析」,与新旧架构
 * 之争无关。放在旧侧只是因为它先建在那里。
 *
 * 与 `storage/db.ts` 里那处临时依赖同一个处置方式:等 `src/server/**` 进入删除
 * 阶段时整体搬过来,搬迁时机由**编译失败**提醒,不靠人记得。
 */
import { join } from "node:path";
import { Keyring } from "../../server/storage/keyring.js";
import { SettingsStore, type ProviderConfig, type Settings } from "../../server/settings/store.js";
import { resolveModel, syncActiveProviderApiKeyEnv } from "../../server/providers/registry.js";
import { openPlatformDb } from "../storage/db.js";
import { SqliteMemory } from "../memory/sqliteMemory.js";
import { createLoggingClientChannel } from "../client/port.js";
import type { PlatformModel } from "./session.js";
import type { RuntimeDeps } from "./assembly.js";

export interface BootOptions {
  /** 数据目录(设置与密钥环从这里读) */
  readonly dataDir: string;
  /** 平台库路径。缺省 `<dataDir>/sansheng.db` —— 与旧系统**同一个文件** */
  readonly dbPath?: string;
  /** 记忆后端。缺省启用 */
  readonly enableMemory?: boolean;
  /** 甲方通道。缺省用日志通道(不假装送达,但留痕) */
  readonly clientLog?: (line: string) => void;
  /** 注入时钟(id / now),测试可控 */
  readonly now?: () => number;
  readonly newId?: (prefix: string) => string;
}

export interface BootedPlatform {
  readonly deps: RuntimeDeps;
  readonly settings: Settings;
  /** 当前 provider 配置;没配 provider 时为 null */
  readonly provider: ProviderConfig | null;
  /** 解析出的模型;没配 provider 或模型不认识时为 null */
  readonly model: PlatformModel | null;
  readonly dbPath: string;
  close(): void;
}

/**
 * 装配一个可运行的平台。
 *
 * **不抛异常表示「能跑」** —— provider 缺失、模型解析不出都只是 `provider` /
 * `model` 为 null,由调用方决定怎么报。启动路径上的异常会以栈回溯形式出现,
 * 而这里能给出可读得多的原因。
 */
export function bootPlatform(opts: BootOptions): BootedPlatform {
  const keyring = new Keyring(join(opts.dataDir, ".keyring"));
  const settingsStore = new SettingsStore(join(opts.dataDir, "settings.json"), keyring);
  const settings = settingsStore.load();

  const provider = settingsStore.activeProvider() ?? null;
  let model: PlatformModel | null = null;
  if (provider !== null) {
    // **必须先同步凭据到 env**,再解析模型。
    //
    // `createAgentSession` 内部自建 `ModelRuntime.create({ authPath })`,而
    // Sansheng 不写 agentDir/auth.json —— 凭据实际来自 env。首跑冒烟就卡在这里:
    // 「No API key found for minimax-cn」,而 settings 里明明配了。
    //
    // 这条 env 泄漏无法完全避免(Pi session 的工具会 spawn 子进程,那些子进程
    // 也必须有凭据)。旧系统的处置是把它收敛到「只有 active provider、只在建
    // session 前」,这里沿用同一处置。
    syncActiveProviderApiKeyEnv(provider.provider, provider.apiKey);
    model = resolveModel({
      provider: provider.provider,
      modelId: provider.modelId,
      apiKey: provider.apiKey,
      baseUrl: provider.baseUrl ?? null,
    });
  }

  const dbPath = opts.dbPath ?? join(opts.dataDir, "sansheng.db");
  const db = openPlatformDb(dbPath);

  const memory =
    opts.enableMemory === false
      ? undefined
      : new SqliteMemory(db, {
          newId: opts.newId ?? defaultNewId,
          now: opts.now ?? (() => Date.now()),
        });

  const clientLog = opts.clientLog ?? ((line: string) => console.log(line));

  const deps: RuntimeDeps = {
    db,
    ...(memory !== undefined ? { memory } : {}),
    client: createLoggingClientChannel(clientLog),
    now: opts.now ?? (() => Date.now()),
    newId: opts.newId ?? defaultNewId,
  };

  return {
    deps,
    settings,
    provider,
    model,
    dbPath,
    close: () => db.close(),
  };
}

function defaultNewId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
