/**
 * harness 的**状态判据**(纯函数,不 import React)—— 2026-11-14 从
 * `components/members/RoleHarness.tsx` 搬出。
 *
 * ── 为什么要单独一份 ─────────────────────────────────────────────
 *
 * 同一批判据现在有**两个读者**:成员页的「角色 harness」卡(某角色一块)与
 * 新的「Harness 管理」页(`routes/HarnessManage.tsx`,跨角色一屏)。判据若留在
 * 成员页那边,管理页要么各抄一遍(两份会漂开 —— 「同一个状态两种说法」正是
 * 本项目反复清的病),要么根本没得抄。
 *
 * 所以事实的**来源**只有一个:`GET /api/harness`(`HarnessView`);**读法**只有
 * 这一份。两个页面都从这里拿,谁也不许另写一套「已加载 / 缺失 / 求解不了」。
 *
 * 从 `RoleHarness.tsx` 逐字搬来的(语义一个字没改,判据见
 * `tests/web/harness-by-role.test.ts`):
 *   - `OpState` / `failureOf` —— 一次保存 / 恢复的失败读数;
 *   - `sharedUnitOwners` —— 每个单元被哪些角色声明(「共用于 N 个角色」);
 *   - `roleIssueCount` —— 四类「需要注意」的和(页签/列表的告警角标);
 *   - `toolSetStateLabel` / `toolSetStateDetail` / `harnessStatusText` /
 *     `toolCountText` —— 卡片头与工具面的状态措辞(只有一处)。
 *
 * 本文件新增的两个判据(管理页专用,但同样是纯函数):
 *   - `harnessGlobalIssues` —— 顶部全局状态:缺失单元 / 无效集合文件 / 陌生文件;
 *   - `resolveSelectedRole` —— 深链接 `?role=` 的读法(地址点名了就精确找,
 *     没点名才退到第一个;**找不到不编**,返回 null 让页面如实说「没有这个角色」)。
 */
import type {
  HarnessView,
  PromptUnitView,
  RoleHarnessView,
} from "@shared/types/platform";
import { ApiError, errorMessage } from "@/lib/api";

/**
 * 声明了但盘上没有文件的单元(「这条职责从没告诉过 agent」—— 7-B 的守卫)。
 * **唯一**的「缺失」公式:角标(`roleIssueCount`)、全局状态
 * (`harnessGlobalIssues`)与成员页/管理页的告警都从这里拿 —— 别处再写一遍
 * `.filter((u) => !u.loaded)` 就是第二套判据(哨兵在
 * `tests/web/harness-manage.test.ts` ⑥)。
 */
export function missingUnits(role: RoleHarnessView): PromptUnitView[] {
  return role.promptUnits.filter((u) => !u.loaded);
}

/** 一次保存 / 恢复的结果。`failed` 带上 `validIds` —— 后端在 `unknown_unit` 时给。 */
export type OpState =
  | { kind: "idle" }
  | { kind: "busy"; what: "save" | "reset" }
  | { kind: "ok"; text: string }
  | { kind: "failed"; message: string; validIds?: string[] };

export function failureOf(e: unknown): OpState {
  const message = errorMessage(e);
  if (e instanceof ApiError) {
    return {
      kind: "failed",
      message: `${e.code}: ${message}`,
      ...(e.validIds !== undefined ? { validIds: e.validIds } : {}),
    };
  }
  return { kind: "failed", message };
}

/**
 * 每个单元被**哪些角色**声明(显示名)。
 *
 * 为什么要它:同一个文件被多个角色声明是**正常**的(`ROLE_SPECS[].promptUnits`
 * 里 `collaboration.ask` 3 处、`collaboration.convene` 2 处),但页面上它会在
 * 每个角色的面板里各出现一次、长得跟「三份不同的文件」一样。标注出来之后:
 * 「我改的是那个共用文件,会影响这几个角色」是**看得见**的。
 *
 * ⚠️ 它要的是**整份** harness 视图(所有角色),不是当前这一个角色 ——
 * 只拿着一个角色算不出「共用于几个角色」。
 */
export function sharedUnitOwners(
  roles: readonly RoleHarnessView[],
): Map<string, string[]> {
  const owners = new Map<string, string[]>();
  for (const r of roles) {
    for (const u of r.promptUnits) {
      const cur = owners.get(u.id);
      if (cur === undefined) owners.set(u.id, [r.displayName]);
      else if (!cur.includes(r.displayName)) cur.push(r.displayName);
    }
  }
  return owners;
}

/** 一个角色身上**需要注意**的处数(告警角标)。四类互不重叠,直接相加。 */
export function roleIssueCount(role: RoleHarnessView): number {
  return (
    missingUnits(role).length +
    (role.toolSet.state === "invalid" ? 1 : 0) +
    role.blockedByCeiling.length +
    role.unknownTools.length
  );
}

/**
 * 集合文件状态的三种读法。**卡片头、面板摘要行与管理页的工具面共用同一处实现**
 * —— 两个地方各写一份的话,「文件无效」在某一边被漏掉时不会有任何东西红。
 */
function toolSetStateLabel(state: RoleHarnessView["toolSet"]["state"]): string {
  return state === "ok"
    ? "生效中"
    : state === "absent"
      ? "无文件 · 按 ceiling 全集(出厂行为)"
      : "文件无效 · 已退化成 ceiling 全集";
}

/** 摘要行用的那一格:状态词 + (只有 ok 时)「收掉 N 个」。 */
export function toolSetStateDetail(role: RoleHarnessView): string {
  return (
    toolSetStateLabel(role.toolSet.state) +
    (role.toolSet.state === "ok"
      ? ` · 收掉 ${role.toolSet.removedByToolSet.length} 个`
      : "")
  );
}

/**
 * 「角色 harness」那张卡**卡片头**上一行状态摘要的正文。
 *
 * 为什么要抽成一个纯函数:它是**折叠状态下唯一能读到的判据**(用户要的正是
 * 「不展开就知道这个角色正不正常」),因此必须能被测试直接断言;抽出来也保证
 * 「求解不了(组织未播种)≠ 0 个」这条判据只有**一处**实现,不会与面板里的
 * 摘要行分叉。
 *
 * ⚠️ `toolsSolved === false` 的措辞是「求解不了(组织未播种)」,不是「0 个」——
 * 前者是「算不出来」(库里连这个角色的 agent 行都没有),后者是「一个都没有」。
 * 判据是 `=== false` 而不是 `!toolsSolved`:字段缺失(前端比后端新)必须退化回
 * 显示计数,否则会把「旧后端没这个字段」误报成「组织未播种」。
 */
export function harnessStatusText(role: RoleHarnessView): string {
  const loaded = role.promptUnits.filter((u) => u.loaded).length;
  return (
    `单元 ${loaded}/${role.promptUnits.length} 已加载 · ` +
    `能力 ${role.ceiling.length} 项 · ` +
    (role.toolsSolved !== false
      ? `实得工具 ${role.tools.length} 个`
      : "实得工具 求解不了(组织未播种)") +
    ` · 集合文件 ${toolSetStateLabel(role.toolSet.state)}`
  );
}

/**
 * ④ 块里「实得工具」那一行的正文。三态与摘要行(`harnessStatusText`)**同一套判据**,
 * 不在这里另立一套:
 *
 *   `toolsSolved === false`  = **算不出来**(库里连这个角色的 agent 行都没有);
 *   求解过了且 `tools.length === 0` = **真的是 0 个**(接待阶段的合法形状);
 *   其余 = 计数。
 *
 * ⚠️ 前两种在屏幕上**不许长成一个样**:0 是一个事实,「算不出来」是一个缺口。
 * 本项目的真机现场就是这两件事长得一模一样(2026-10-05,见 `harnessStatusText`)。
 */
export function toolCountText(role: RoleHarnessView): string {
  if (role.toolsSolved === false) return "求解不了(组织未播种)";
  if (role.tools.length === 0) return "0 个(过完三道门确实一个都没有)";
  return `${role.tools.length} 个`;
}

// ── 管理页(2026-11-14)新增的两个判据 ─────────────────────────────

/** 顶部全局状态里的一类问题。`headline` 是屏上的一句,`detail` 是逐项点名。 */
export interface HarnessGlobalIssue {
  kind: "missing_units" | "invalid_toolset" | "stray_files";
  headline: string;
  detail: string;
}

/**
 * 跨角色的**全局问题**:哪些单元缺失、哪些角色的集合文件无效、哪些集合文件名
 * 不属于任何角色。管理页顶部一行画的就是它 —— 用户不点开任何角色就该看见
 * 「哪里有问题」。
 *
 * ⚠️ 三类判据与 `roleIssueCount` 的前两类 + `strayToolSetFiles` **同源**
 * (同一个 `HarnessView`),只是换了聚合方向(跨角色)。空数组 = 真的没有问题
 * (数据已 `ready`),不是「没查」。
 */
export function harnessGlobalIssues(view: HarnessView): HarnessGlobalIssue[] {
  const issues: HarnessGlobalIssue[] = [];
  const missing = view.roles.flatMap((r) =>
    missingUnits(r).map((u) => `${r.displayName}·${u.id}`),
  );
  if (missing.length > 0) {
    issues.push({
      kind: "missing_units",
      headline: `${missing.length} 个提示词单元声明了但盘上没有文件`,
      detail: missing.join(" · "),
    });
  }
  const invalid = view.roles.filter((r) => r.toolSet.state === "invalid");
  if (invalid.length > 0) {
    issues.push({
      kind: "invalid_toolset",
      headline: `${invalid.length} 个角色的工具集合文件无效(已退化成 ceiling 全集)`,
      detail: invalid
        .map((r) => `${r.displayName}:${r.toolSet.problem ?? "原因未给出"}`)
        .join(" · "),
    });
  }
  if (view.strayToolSetFiles.length > 0) {
    issues.push({
      kind: "stray_files",
      headline: `${view.strayToolSetFiles.length} 个工具集合文件名不属于任何角色,不会被读取(文件名必须是 {role}.json)`,
      detail: view.strayToolSetFiles.join(" · "),
    });
  }
  return issues;
}

/**
 * 深链接 `#/harness?role=…` 的读法。
 *
 * ⚠️ **地址点名了就精确找,找不到不编** —— 返回 `null`,让页面如实说
 * 「视图里没有这个角色」(与 `RoleHarnessDisclosure` 的负样本同一句话):
 * 静默退到第一个角色会把「指向空气的地址」伪装成「成功打开」。
 * 只有**没点名**(`role=` 缺失)时才默认第一个 —— 那是「没选」,不是「选错了」。
 */
export function resolveSelectedRole(
  requested: string | null,
  roles: readonly RoleHarnessView[],
): RoleHarnessView | null {
  if (roles.length === 0) return null;
  if (requested === null) return roles[0]!;
  return roles.find((r) => r.role === requested) ?? null;
}
