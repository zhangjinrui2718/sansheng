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
import { Keyring } from "../infra/keyring.js";
import { SettingsStore, type ProviderConfig, type Settings } from "../infra/settings.js";
import { resolveModel, syncActiveProviderApiKeyEnv } from "../infra/providers.js";
import { openPlatformDb } from "../storage/db.js";
import { SqliteMemory } from "../memory/sqliteMemory.js";
import { createLoggingClientChannel } from "../client/port.js";
import { createGitCodeService } from "../codeservice/git.js";
import { createGitWorkspace } from "../workspace/git.js";
import { resolveAllToolSets, strayToolSetFiles, toolSetForDataDir } from "../harness/toolSet.js";
import { log } from "../../shared/log.js";
import type { PlatformModel } from "./session.js";
import type { RuntimeDeps } from "./assembly.js";
import type { WorkspacePort } from "../workspace/port.js";

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
  /**
   * **工作根** —— 会话 `cwd` / 代码服务仓库的根。
   *
   * 缺省 `settings.cwd`。显式给它是为了 `--cwd` 那条路:`sessionCwd()` 用的是
   * `opts.cwd ?? settings.cwd`,而 `code_service` 的**包含性校验**必须与它同一个根。
   * 两者不一致时会出现一种极难查的形态:仓库明明在「这次会话的工作目录」里,
   * 核对却说它在工作根之外(见 `codeservice/git.ts` 的包含性校验)。
   */
  readonly workspaceRoot?: string;
  /**
   * **工作区端口**(测试 seam)。缺省就是真实现 `createGitWorkspace()`。
   *
   * 它**不是可选能力**:工件正文 2026-10-08 起住项目仓里的文件(设计
   * `docs/DESIGN-WORKSPACE.md` §4),没有它 `board_write` 会 fail-closed 拒绝。
   * 所以这里给的是「换一个实现」的口子,不是「可以不接」—— 缺省值就是真实现。
   */
  readonly workspace?: WorkspacePort;
}

export interface BootedPlatform {
  readonly deps: RuntimeDeps;
  readonly settings: Settings;
  /** 当前 provider 配置;没配 provider 时为 null */
  readonly provider: ProviderConfig | null;
  /** 解析出的模型;没配 provider 或模型不认识时为 null */
  readonly model: PlatformModel | null;
  readonly dbPath: string;
  /**
   * 设置存储。暴露出来是因为**设置会变** —— 用户改 provider 之后,
   * 下一次建会话必须用新的模型,而 boot 时解析的那个会过期。
   */
  readonly settingsStore: SettingsStore;
  /** 时钟 —— bootPlatform 总会提供,这里提升为必填,免得调用方到处写 `?.()` */
  readonly now: () => number;
  /** id 生成 —— 同上 */
  readonly newId: (prefix: string) => string;
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

  /**
   * 用户工具集合文件(L2)的接线。
   *
   * ⚠️ 在批次 19 之前这里**没有这一行** —— `solveToolset` 的 `userToolSet` 参数
   * 逻辑完整却没有任何生产调用方传它,于是 `<dataDir>/harness/tools/*.json`
   * 是一份零读者的 JSON:用户改了它,权限一点没变,而界面上只显示 ceiling。
   * 那不是「保守」,是「声称有、实际没有」。
   *
   * 读盘是懒的(每次建会话现读),所以用户改完文件不必重启服务。
   */
  const toolSetFor = toolSetForDataDir(opts.dataDir);

  // 开机时把 L2 的**真实状态**说出来。三种状态里只有 `ok` 会真的收窄工具面;
  // `invalid` 会退化成 ceiling 全集(方向上是**放宽**)—— 那一条必须以 warn
  // 出现,否则「文件坏了」和「文件生效了」在日志里长得一模一样。
  for (const r of resolveAllToolSets(opts.dataDir)) {
    if (r.state === "ok") {
      log.muted(
        `harness: 工具集合生效 ${r.role} ← ${r.path} ` +
          `(allow ${r.file?.allow.length ?? 0} 条 · deny ${r.file?.deny.length ?? 0} 条)`,
      );
    } else if (r.state === "invalid") {
      log.warn(`harness: 工具集合无效 ${r.role} ← ${r.path}\n        ${r.problem?.detail ?? ""}`);
    }
  }
  // 落在空处的意图:文件名写错(如 workers.json)会被安静忽略
  const stray = strayToolSetFiles(opts.dataDir);
  if (stray.length > 0) {
    log.warn(
      `harness: 工具目录里有不认识的 ${stray.length} 个文件(${stray.join(", ")})—— ` +
        `集合文件名必须是 ${"<role>.json"},不是角色名的文件不会被读取`,
    );
  }

  const deps: RuntimeDeps = {
    db,
    ...(memory !== undefined ? { memory } : {}),
    client: createLoggingClientChannel(clientLog),
    now: opts.now ?? (() => Date.now()),
    newId: opts.newId ?? defaultNewId,
    toolSetFor,
    // 代码服务的核对面(migration 026 的 `code_service` 交付物)。
    // ⚠️ 根取 `workspaceRoot ?? settings.cwd`,与 `serve.ts` 的 `sessionCwd()`
    // 走同一个默认值 —— 详见 `BootOptions.workspaceRoot`。
    codeService: createGitCodeService({
      workspaceRoot: opts.workspaceRoot ?? settings.cwd,
    }),
    // 工作区(设计 §3.1 / §4.3):工件正文落盘 + 回合边界提交。
    // 两者**成对**:端口提供能力,根提供「相对哪个根」(见 `RuntimeDeps` 的注释)。
    workspace: opts.workspace ?? createGitWorkspace(),
    workspaceRoot: opts.workspaceRoot ?? settings.cwd,
  };

  return {
    deps,
    settingsStore,
    settings,
    provider,
    model,
    dbPath,
    now: deps.now ?? (() => Date.now()),
    newId: deps.newId ?? defaultNewId,
    close: () => db.close(),
  };
}

function defaultNewId(prefix: string): string {
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}${rand}`;
}
