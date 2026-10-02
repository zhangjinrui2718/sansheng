/**
 * Sansheng Settings · 持久化到 ~/.sansheng/settings.json
 *
 * M1.5: 支持多 provider。settings.providers[] 存所有配置,activeProviderId 指定当前用哪个。
 *        兼容旧的单 provider 格式(load 时自动迁移)。
 * M2:    apiKey 在磁盘上用 Keyring 加密;内存里永远保持明文方便 kernel / UI 读取。
 *        启动时检测到明文残留会一次性升级为加密格式。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { log } from "../../shared/log.js";
import { Keyring, isEncrypted } from "../storage/index.js";

/**
 * 批次 4b C5(审查 §C5「settings.json 写盘非原子」):同目录 tmp + rename。
 *
 * 为什么必须原子:`writeFileSync(目标路径)` 是「截断 → 逐块写」,写一半崩溃 /
 * 断电 / 磁盘满都会留下**截断的 JSON**;而 load() 遇到解析失败恰恰是静默清空
 * 全部配置(见 load 的 catch)。两个缺陷互相成就:一次半截写 = 静默丢掉用户全部
 * provider 配置。同目录 rename 在同一文件系统上是原子的,读者要么看到完整旧
 * 文件,要么看到完整新文件。
 *
 * 序列化在写之前完成(见 SettingsStore.save):序列化抛错时**一个字节都没落盘**,
 * 旧文件原样保留。
 */
export function writeJsonAtomic(file: string, data: string, mode = 0o600): void {
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // tmp 名带 pid + 随机:并发多进程 / 残留 tmp 都不会互相覆盖
  const tmp = join(dir, `.${randomBytes(6).toString("hex")}-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, data, { mode });
    // rename 保留 mode(tmp 上就已经是 0600),显式 chmod 只是把「umask 改坏了」
    // 这种环境也拉回 0600。
    renameSync(tmp, file);
  } catch (err) {
    // rename 失败时别把 tmp 留在磁盘上(里面是**全部 provider 的密钥**)。
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function isMaskedApiKey(s: string): boolean {
  if (!s) return true;
  if (s === "****") return true;
  if (/^\*+$/.test(s)) return true;
  if (s.includes("****")) return true;
  return false;
}

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high";

export interface ProviderConfig {
  id: string;
  label: string;
  provider: string;
  modelId: string;
  apiKey: string;
  baseUrl?: string;
  thinkingLevel: ThinkingLevel;
}

export interface Settings {
  providers: ProviderConfig[];
  activeProviderId: string;
  cwd: string;
  personaName: string;
  agentDir?: string;
  costBudgetUsd?: number;
  monthlySpentUsd?: number;
  lastResetAt?: number;
}

export function genProviderId(): string {
  return `prov_${randomBytes(4).toString("hex")}`;
}

/* ──────────────────────────────────────────────────────────────── *
 * 批次 6:默认工作根从 $HOME 固定为 ~/sansheng-workspace
 *
 * 用户报障(2026-10-02):出厂 cwd = $HOME 让 agent 的工作根是**整个家目录** ——
 * 「跑命令 / 读写文件」的根无处不在。裁决(jev conf 1.00)= `~/sansheng-workspace`:
 * 可见、与应用数据目录 `~/.sansheng` 物理分离(清数据不动工作区)、ASCII、
 * 且避开源码仓库名 `~/projects/sansheng`。
 *
 * 惰性求值(而不是模块加载期算死):CLI/daemon 启动时 process.env 可能被改写
 * (旧实现 `process.env.HOME ?? "/root"` 正是被 env 污染的写法,daemon 模式下
 * 拿到的可能不是用户家目录),os.homedir() 在 POSIX 上优先读 env HOME、
 * 退回 passwd 查询,每次调用都拿当下真值。
 * ──────────────────────────────────────────────────────────────── */

/** 固定工作目录名(测试与 kernel 共用的唯一字面量真相) */
export const DEFAULT_WORKSPACE_DIR_NAME = "sansheng-workspace";

/** 出厂默认 cwd = <homedir>/sansheng-workspace */
export function defaultWorkspaceDir(): string {
  return join(homedir(), DEFAULT_WORKSPACE_DIR_NAME);
}

/** 旧出厂默认(≤ 批次 6):`process.env.HOME ?? "/root"` 的实际取值 = os.homedir() */
export function legacyDefaultCwd(): string {
  return homedir();
}

/**
 * 存量判定:**严格相等**,绝不做前缀 / 包含判定。
 *
 * 理由:用户完全可能有意把工作根设成 `$HOME/projects/x` 或 `$HOME-old`;
 * 任何"以 $HOME 开头"的启发式都会把这些显式设置覆盖成出厂默认 —— 那是
 * 静默改写用户配置,比报障本身更糟。
 */
export function isLegacyDefaultCwd(cwd: string | null | undefined): boolean {
  return typeof cwd === "string" && cwd.length > 0 && cwd === legacyDefaultCwd();
}

function defaultSettings(): Settings {
  return {
    providers: [],
    activeProviderId: "",
    cwd: defaultWorkspaceDir(),
    personaName: "三生",
  };
}

export class SettingsStore {
  private cache: Settings | null = null;
  constructor(
    private readonly file: string,
    private readonly keyring: Keyring | null,
  ) {}

  load(): Settings {
    if (this.cache) return this.cache;
    if (!existsSync(this.file)) {
      this.cache = { ...defaultSettings(), providers: [] };
      this.ensureDefaultWorkspaceDir(this.cache.cwd);
      return this.cache;
    }
    let parsed: Settings;
    let wasLegacy = false;
    try {
      const raw = JSON.parse(readFileSync(this.file, "utf-8")) as Record<string, unknown>;
      wasLegacy = !Array.isArray(raw.providers);
      parsed = this.migrate(raw);
    } catch (err) {
      // C5(审查 §C5「损坏 → 静默清空全部配置」):旧实现这个 catch 只做了
      // `parsed = {...DEFAULTS}`,没有一行日志 —— 用户看到的是「所有 provider
      // 都没了」,而日志里干干净净;随后任意一次 save() 还会把默认值写回磁盘,
      // 旧配置**永久**丢失。现在:响亮 log.error + 先备份原文件再降级。
      // 仍然降级为默认值(不猜内容),但内容没丢:备份在同目录,人可恢复。
      log.error(
        `settings: ${this.file} is corrupt — falling back to defaults. A verbatim backup has been kept; fix the file and restart to restore. (parse error: ${
          err instanceof Error ? err.message : String(err)
        })`,
      );
      this.backupCorruptFile();
      parsed = { ...defaultSettings(), providers: [] };
      this.cache = parsed;
      this.ensureDefaultWorkspaceDir(parsed.cwd);
      return this.cache;
    }

    // 解密:内存里绝不存密文(apiKey 永远是 plain)。同时检测明文残留 → 升级到加密。
    let anyWasPlain = false;
    if (this.keyring) {
      parsed = {
        ...parsed,
        providers: parsed.providers.map((p) => {
          if (!p.apiKey) return p;
          if (isMaskedApiKey(p.apiKey)) return p;
          if (isEncrypted(p.apiKey)) {
            try {
              const decrypted = this.keyring!.decrypt(p.apiKey);
              // 防御:解密结果是 masked/空 → 视为损坏,清空
              if (!decrypted || isMaskedApiKey(decrypted)) {
                log.warn(`settings: failed to decrypt apiKey for provider ${p.id} — cleared`);
                return { ...p, apiKey: "" };
              }
              return { ...p, apiKey: decrypted };
            } catch (err) {
              log.warn(`settings: decrypt error for provider ${p.id}:`, err);
              return { ...p, apiKey: "" };
            }
          }
          // 明文 apiKey → 记下来,稍后升级到加密
          anyWasPlain = true;
          return p;
        }),
      };
    } else {
      log.warn("settings: no Keyring configured — apiKey will be stored in plaintext");
    }

    // 批次 6 P2:存量迁移。已持久化值优先(`raw.cwd ?? 默认`),所以只改默认值对
    // 已有 settings.json(用户那份 cwd = "/Users/fuyao")完全无效 —— 必须在 load
    // 期把「恰好等于旧默认」的那一个值改写掉,否则迁移永远不发生。
    // 判据是严格相等(见 isLegacyDefaultCwd),用户显式设过的其它值一律不动。
    let cwdMigrated = false;
    if (isLegacyDefaultCwd(parsed.cwd)) {
      const next = defaultWorkspaceDir();
      log.info(
        `settings: cwd migrated from the legacy default $HOME (${legacyDefaultCwd()}) → ${next} (batch 6; set any absolute path in 「设置 → 工作目录」 to override)`,
      );
      parsed = { ...parsed, cwd: next };
      cwdMigrated = true;
    }

    this.cache = parsed;
    this.ensureDefaultWorkspaceDir(parsed.cwd);

    // 升级:legacy 格式 OR 明文残留 OR cwd 迁移 → 重新写盘(走既有原子 save)
    if (wasLegacy || anyWasPlain || cwdMigrated) {
      try {
        this.save(parsed);
        log.info(
          `persisted settings.json (legacy=${wasLegacy}, upgradedPlaintext=${anyWasPlain}, migratedCwd=${cwdMigrated})`,
        );
      } catch (err) {
        log.warn("failed to persist upgraded settings:", err);
      }
    }

    return this.cache;
  }

  /**
   * 批次 6 P1:固定工作目录**自动创建** —— 仅限「生效 cwd 恰好等于出厂默认目录」。
   *
   * 为什么不建用户自定义路径:用户在设置里敲 `/Users/fuyao/project` 少了个字符,
   * 无声 mkdir 会把打错的路径变成真实空目录(而且是在他的家目录里),制造
   * 「这目录哪来的」噪音。自定义路径建不建由用户自己负责。
   *
   * 失败不崩:家目录只读 / 磁盘满 / 路径被文件占位(ENOTDIR)都不该让服务起不来
   * —— 降级 log.warn,cwd 值照常生效(agent 之后按需自己 mkdir,或用户手改)。
   */
  private ensureDefaultWorkspaceDir(cwd: string): void {
    if (cwd !== defaultWorkspaceDir()) return;
    if (existsSync(cwd)) return;
    try {
      mkdirSync(cwd, { recursive: true });
      log.info(`settings: created default workspace directory ${cwd}`);
    } catch (err) {
      log.warn(
        `settings: failed to create the default workspace directory ${cwd} — cwd stays set to it, but file operations may fail until it exists:`,
        err,
      );
    }
  }

  /** 把磁盘上的 JSON(可能是旧单-provider 格式)规整成新格式 */
  private migrate(raw: Record<string, unknown>): Settings {
    const cwd = (raw.cwd as string) ?? defaultSettings().cwd;
    const personaName = (raw.personaName as string) ?? defaultSettings().personaName;
    const agentDir = raw.agentDir as string | undefined;

    // 新格式:已有 providers 数组
    if (Array.isArray(raw.providers)) {
      const providers = (raw.providers as ProviderConfig[]).map((p) => this.sanitizeProvider(p));
      let activeProviderId = (raw.activeProviderId as string) ?? "";
      if (!providers.find((p) => p.id === activeProviderId)) {
        activeProviderId = providers[0]?.id ?? "";
      }
      return {
        providers,
        activeProviderId,
        cwd,
        personaName,
        agentDir,
        costBudgetUsd: raw.costBudgetUsd as number | undefined,
        monthlySpentUsd: raw.monthlySpentUsd as number | undefined,
        lastResetAt: raw.lastResetAt as number | undefined,
      };
    }

    // 旧格式:单 provider 字段 → 迁移成 providers[0]
    const legacyProvider = raw.provider as string | undefined;
    const legacyModel = raw.modelId as string | undefined;
    const legacyKey = raw.apiKey as string | undefined;
    if (legacyProvider && legacyModel) {
      const id = genProviderId();
      const provider: ProviderConfig = {
        id,
        label: legacyProvider,
        provider: legacyProvider,
        modelId: legacyModel,
        // 旧值若是 masked placeholder,清空
        apiKey: legacyKey && !isMaskedApiKey(legacyKey) ? legacyKey : "",
        baseUrl: raw.baseUrl as string | undefined,
        thinkingLevel: (raw.thinkingLevel as ThinkingLevel) ?? "medium",
      };
      log.info(`migrated legacy single-provider settings → providers[0] (${legacyProvider}/${legacyModel})`);
      return { providers: [provider], activeProviderId: id, cwd, personaName, agentDir };
    }

    return { providers: [], activeProviderId: "", cwd, personaName, agentDir };
  }

  private sanitizeProvider(p: Partial<ProviderConfig>): ProviderConfig {
    return {
      id: p.id || genProviderId(),
      label: p.label || p.provider || "未命名",
      provider: p.provider || "",
      modelId: p.modelId || "",
      apiKey: p.apiKey && !isMaskedApiKey(p.apiKey) ? p.apiKey : "",
      baseUrl: p.baseUrl || undefined,
      thinkingLevel: p.thinkingLevel ?? "medium",
    };
  }

  save(s: Settings): void {
    const dir = join(this.file, "..");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

    const onDisk: Settings = {
      ...s,
      providers: s.providers.map((p) => {
        if (!p.apiKey) return p;
        if (isMaskedApiKey(p.apiKey)) {
          throw new Error(`refusing to save masked apiKey for provider ${p.id} as encrypted`);
        }
        if (this.keyring) {
          if (isEncrypted(p.apiKey)) return p; // 已经加密(可能 UI 拷贝回填)
          return { ...p, apiKey: this.keyring.encrypt(p.apiKey) };
        }
        // 没有 keyring → 明文直存(警告已在 load 时打)
        return p;
      }),
    };

    // 先序列化再落盘:序列化抛错(循环引用 / BigInt)时**一个字节都没写**,
    // 旧文件原样保留 —— 原子写的另一半(见 writeJsonAtomic 注释)。
    const data = JSON.stringify(onDisk, null, 2);
    // C5:tmp + rename,不再原地截断重写(半截 JSON 正好触发上面的静默清空)。
    writeJsonAtomic(this.file, data, 0o600);
    this.cache = s;
  }

  /**
   * C5:损坏的 settings.json 在降级为默认值**之前**留一份逐字节备份。
   * 命名带时间戳 → 连续两次损坏产生两份备份,不会互相覆盖。
   * 备份失败不阻塞降级(用户至少还能看到 log.error 里的文件名)。
   */
  private backupCorruptFile(): void {
    // 名字带时间戳 + 随机串:同一毫秒内连续两次损坏(例如 load 两次)也不会互相覆盖。
    const backup = `${this.file}.corrupt-${Date.now()}-${randomBytes(4).toString("hex")}`;
    try {
      // 逐字节复制:不重新序列化(那正是坏掉的东西)。
      writeFileSync(backup, readFileSync(this.file), { mode: 0o600 });
      log.warn(`settings: corrupt file backed up to ${backup}`);
    } catch (err) {
      log.error(
        `settings: failed to back up corrupt file to ${backup} — it will be overwritten by the next save():`,
        err,
      );
    }
  }

  /** 返回当前激活的 provider 配置(可能为 undefined) */
  activeProvider(): ProviderConfig | undefined {
    const s = this.load();
    return s.providers.find((p) => p.id === s.activeProviderId) ?? s.providers[0];
  }

  /**
   * 批次 4b B5(审查 §B5):丢弃内存缓存,下次 load() 强制重新读盘。
   *
   * 用于 `/api/reset`:即便配置文件**没被删**,也让「内存里的副本」与磁盘重新
   * 对齐 —— 万一 rm 波及到配置(partial failure),也不会拿内存里的旧副本继续
   * 往磁盘写。幂等;不影响已经持有 Settings 引用的调用方(下次 load 才是新的)。
   */
  invalidate(): void {
    this.cache = null;
  }

  reset(): void {
    this.save({ ...defaultSettings(), providers: [] });
  }
}

export { isMaskedApiKey };