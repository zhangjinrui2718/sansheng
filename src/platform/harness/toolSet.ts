/**
 * Sansheng 平台 · BC5 Harness · 用户工具集合文件(L2)的**读写源**
 *
 * 来源:`docs/DESIGN-PLATFORM.md` §7.1 的三层工具面。
 *
 * ── 为什么需要这个文件(它不是「顺手抽一层」)────────────────────
 *
 * 三层是:
 *
 *   L1  `ROLE_SPECS[role].ceiling`        代码内常量(架构上界)
 *   L2  `<dataDir>/harness/tools/{role}.json`  用户可编辑的集合文件 ← **本文件**
 *   L3  出厂集合 = L2 的初值(由 ceiling 推导,不另存名单)
 *
 * 7-E 的裁决:「**升级集合**」(改文件)与「**解除架构约束**」(改代码)是两件事。
 * L2 让用户在上界内收窄,永远突破不了 L1。
 *
 * 在批次 19 之前,这条裁决只落在 `authorize.ts` 的 `solveToolset` 里 ——
 * 判定逻辑写得完整且正确,但**生产接线上没有任何人传 `userToolSet`**,而且
 * `<dataDir>/harness/tools/*.json` **零读者**。净效果是那份 JSON 改了没有任何
 * 效果,而界面上看不出这一点。这个文件把两头接上:盘上的 JSON → `ToolSetFile`
 * → `RuntimeDeps.toolSetFor`。
 *
 * ── fail-closed 的具体含义(这里很容易做反)──────────────────────
 *
 * 「坏文件」有两种处置,方向相反,必须选对:
 *
 *   ✗ 当成**空 allowlist** → 等于悄悄收回该角色的全部工具。用户改坏一个字符,
 *     整个角色就哑了,而界面上只会显示「它没有工具」—— 一个看起来正常的
 *     错误答案(见 AGENTS.md §三类静默失败)。
 *   ✓ **退化成出厂行为(按 ceiling 全集)+ 如实记账** ← 本文件的选择。
 *
 * 所以:解析失败 / 字段缺失 / 形状不对 → `file = undefined`(调用方按出厂行为
 * 求解)**并且** `problem` 非空,由 HTTP 的 harness 视图与启动日志对用户可见。
 * 记住这条退化在**权限方向上是放宽的**(回落到 L1 全集),这正是它必须可见的理由 ——
 * 一个坏文件不该静默地变成一次提权,也不该静默地变成一次收权。
 *
 * 注意区分「坏文件」与「用户**有意**写了空名单」:`{"allow":[],"deny":[]}` 是
 * 合法文件,它的效果就是该角色一个工具都没有 —— 那是用户的意图,不是故障。
 *
 * ── 路径穿越 ────────────────────────────────────────────────────
 *
 * 文件名来自 `PROJECT_ROLES` 这个**闭合注册表**(角色名),不是用户输入;这里
 * 仍然显式做一次「解析出来的路径必须还在工具目录里」的断言 —— 防的是将来有人
 * 把 role 参数从别处透传进来。写面(若将来加)必须复用同一条判定,见
 * `harness/write.ts` 规矩①。
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { log } from "../../shared/log.js";
import { PROJECT_ROLES, isProjectRole, type ProjectRole } from "../identity/role.js";
import type { ToolSetFile } from "./authorize.js";

/** 集合文件的机器可读状态。`absent` / `invalid` 都退化成出厂行为。 */
export type ToolSetState =
  /** 盘上没有这个角色的文件 —— 出厂行为,不是错误 */
  | "absent"
  /** 文件读到了,形状合法 —— **只有这一种状态会真的收窄工具面** */
  | "ok"
  /** 文件在,但读不了 / 不是合法 JSON / 形状不对 —— 退化成出厂行为,且必须可见 */
  | "invalid";

/** 一条「如实记账」。用户必须能看见它,否则就回到了「声称有、实际没有」。 */
export interface ToolSetProblem {
  readonly role: ProjectRole;
  readonly path: string;
  readonly detail: string;
}

export interface ToolSetResolution {
  readonly role: ProjectRole;
  readonly path: string;
  readonly state: ToolSetState;
  /**
   * 传给 `solveToolset` 的用户集合。**`undefined` = 出厂行为**(按 ceiling 全集),
   * 在 `absent` 与 `invalid` 两种状态下都是它。
   */
  readonly file: ToolSetFile | undefined;
  /** `state === "invalid"` 时非空 —— 退化成出厂行为的**原因**,必须可见 */
  readonly problem: ToolSetProblem | undefined;
}

/** 工具集合文件所在目录(`<dataDir>/harness/tools`)。 */
export function toolSetDir(dataDir: string): string {
  return join(dataDir, "harness", "tools");
}

/**
 * 某个角色的集合文件路径。
 *
 * `role` 在类型上就是 `ProjectRole`(闭合联合),这里再做一次运行期校验 + 目录
 * 归属断言 —— 两道都不贵,而它们是路径穿越的唯一防线(规矩①)。
 */
export function toolSetPath(dataDir: string, role: ProjectRole): string {
  if (!isProjectRole(role)) {
    // 类型上不可达;留着是因为这个值将来可能从句柄 / HTTP 参数进来
    throw new Error(`未知角色「${String(role)}」—— 集合文件名只能来自 PROJECT_ROLES`);
  }
  const dir = resolve(toolSetDir(dataDir));
  const p = resolve(dir, `${role}.json`);
  if (p !== join(dir, `${role}.json`) || !p.startsWith(dir + sep)) {
    throw new Error(`集合文件路径越出了工具目录:${p}`);
  }
  return p;
}

/** 形状判定:纯函数,不认识就返回原因(不抛)。 */
type Parsed = { readonly ok: true; readonly file: ToolSetFile } | { readonly ok: false; readonly detail: string };

/**
 * 校验一份 `ToolSetFile`。
 *
 * **两个字段都必须存在且是字符串数组** —— 缺一个就整份判为 invalid(退化成
 * 出厂行为),而不是「缺 deny 就当空 deny」。理由:集合文件是**用户意图**,
 * 猜一半比不猜更危险 —— `{"allow":["board_read"]}` 少了 deny,如果按空 deny 处理
 * 会得到一个比用户以为的更大的面;而按出厂全集处理,至少界面上会明说
 * 「这份文件没生效,现在用的是上界全集」。
 *
 * 不在这里校验工具名是否合法 —— 那是 `solveToolset` 的职责,它会把不认识的
 * 名字记进 `unknownTools` 并如实报出(拼写错误不静默生效)。
 */
export function parseToolSetFile(raw: unknown): Parsed {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, detail: "顶层必须是一个 JSON 对象" };
  }
  const obj = raw as Record<string, unknown>;
  const allow = obj["allow"];
  const deny = obj["deny"];
  if (!Array.isArray(allow)) {
    return { ok: false, detail: `字段 allow 缺失或不是数组(实际:${describe(allow)})` };
  }
  if (!Array.isArray(deny)) {
    return { ok: false, detail: `字段 deny 缺失或不是数组(实际:${describe(deny)})` };
  }
  // 逐项收窄 + **复制** —— 不在返回值里留一份对入参数组的引用(纯函数契约)。
  // 不用 `as string[]` 糊过去:项目纪律是窄化写 guard / 显式判定。
  const allowOut: string[] = [];
  for (let i = 0; i < allow.length; i++) {
    const v: unknown = allow[i];
    if (typeof v !== "string") {
      return { ok: false, detail: `allow[${i}] 不是字符串(实际:${describe(v)})` };
    }
    allowOut.push(v);
  }
  const denyOut: string[] = [];
  for (let i = 0; i < deny.length; i++) {
    const v: unknown = deny[i];
    if (typeof v !== "string") {
      return { ok: false, detail: `deny[${i}] 不是字符串(实际:${describe(v)})` };
    }
    denyOut.push(v);
  }
  return { ok: true, file: { allow: allowOut, deny: denyOut } };
}

function describe(v: unknown): string {
  if (v === undefined) return "缺失";
  if (v === null) return "null";
  if (Array.isArray(v)) return "数组";
  return typeof v;
}

/**
 * 读一个角色的集合文件。**不抛异常** —— 任何读/解析失败都退化成出厂行为并记账。
 *
 * 这一条很重要:会话建立是启动路径,一个坏 JSON 让整个平台起不来,用户就再也
 * 打不开那个能告诉他「文件坏在哪」的界面了。
 */
export function resolveToolSet(dataDir: string, role: ProjectRole): ToolSetResolution {
  const path = toolSetPath(dataDir, role);

  if (!existsSync(path)) {
    return { role, path, state: "absent", file: undefined, problem: undefined };
  }

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    return invalid(role, path, `读不到文件:${err instanceof Error ? err.message : String(err)}`);
  }

  // 空文件 = 没有内容可解析。它不是「空名单」(那是 `{"allow":[],"deny":[]}`),
  // 而是一个没写完的文件 —— 按坏文件处置。
  if (text.trim() === "") {
    return invalid(role, path, "文件是空的(空文件 ≠ 空名单;要清空工具面请写 {\"allow\":[],\"deny\":[]})");
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    return invalid(role, path, `不是合法 JSON:${err instanceof Error ? err.message : String(err)}`);
  }

  const parsed = parseToolSetFile(raw);
  if (!parsed.ok) return invalid(role, path, parsed.detail);

  return { role, path, state: "ok", file: parsed.file, problem: undefined };
}

function invalid(role: ProjectRole, path: string, detail: string): ToolSetResolution {
  return {
    role,
    path,
    state: "invalid",
    // **不给空 allowlist** —— 退化成出厂行为(按 ceiling 全集),并让 problem 可见。
    file: undefined,
    problem: {
      role,
      path,
      detail:
        `${detail} —— 已退化成出厂行为(按 ROLE_SPECS.ceiling 全集),` +
        `这份文件当前**没有生效**。修好它或删掉它,不要以为权限已经收窄`,
    },
  };
}

/** 四个角色的集合文件状态(顺序与 `PROJECT_ROLES` 一致)。 */
export function resolveAllToolSets(dataDir: string): readonly ToolSetResolution[] {
  return PROJECT_ROLES.map((role) => resolveToolSet(dataDir, role));
}

/**
 * 生产接线用的那一份:`RuntimeDeps.toolSetFor`。
 *
 * 返回的函数**每个回合现读盘** —— 不做进程内缓存。理由是用户改完 JSON 之后
 * 不该需要重启服务才生效;而这个读取只在建会话时发生(不是每次工具调用),
 * 一次几 KB 的同步读不构成问题。缓存反而是那个「用户改了却没效果」的来源。
 *
 * **坏文件在这里留一行 warn。** 只在启动时扫一遍是不够的:用户完全可能在服务
 * 跑着的时候改坏文件,而**下一次建会话就会拿出厂全集跑**(方向上是放宽权限)。
 * 那种事必须留下现场(7-N),不能只靠用户恰好打开 Harness 页才看见。
 */
export function toolSetForDataDir(
  dataDir: string,
): (role: ProjectRole) => ToolSetFile | undefined {
  return (role) => {
    const r = resolveToolSet(dataDir, role);
    if (r.state === "invalid") {
      // 措辞与启动时那条区分开:这条说明「**这一次建会话**用的是出厂全集」,
      // 所以事后翻日志能看出哪一次运行其实没受集合文件约束。
      log.warn(
        `harness: 建会话时工具集合无效 ${role} ← ${r.path} —— 本次按 ceiling 全集\n` +
          `        ${r.problem?.detail ?? ""}`,
      );
    }
    return r.file;
  };
}

/**
 * 工具目录里**存在但不是合法角色名**的 `.json` 文件。
 *
 * 存在的理由:用户很容易把文件写成 `workers.json`(复数)或 `worker.JSON` ——
 * 那份文件会被安静地忽略,而他以为已经生效了。把这种「落在空处的意图」报出来,
 * 是与 `unknownTools` 同一条纪律(拼写错误不静默生效)。
 */
export function strayToolSetFiles(dataDir: string): readonly string[] {
  const dir = toolSetDir(dataDir);
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const known = new Set(PROJECT_ROLES.map((r) => `${r}.json`));
  return names
    .filter((n) => {
      if (known.has(n)) return false;
      if (!n.toLowerCase().endsWith(".json")) return false;
      try {
        return statSync(join(dir, n)).isFile();
      } catch {
        return false;
      }
    })
    .sort();
}
