/**
 * 工具面上每个工具的**类型 / 名称 / 作用** —— `GET /api/harness` 的
 * `RoleHarnessView.toolBriefs` 的唯一实现。
 *
 * ── 为什么要有一个服务端的实现,而不是前端写一张中文表 ────────────────
 *
 * 用户的原话:「工具 做一个表格,按照类型、名称、作用来,现在搞一对英文名称的
 * list,完全不知道都有些啥」。那张表要填的「作用」,平台**早就有一份**:
 * `PlatformTool.description`(写在 `tools/*.ts` 里,由实现这个工具的人写下)。
 * 前端再抄一份中文说明会得到**两份关于「这个工具是干嘛的」的真相**,而它们漂开
 * 的表现是「界面上写的用途」与「模型实际拿到的说明」不一样 —— 屏幕上完全看不出来,
 * 只有对着源码读才发现。所以这一层只做转写,不重写。
 *
 * ── 两条来源,刻意不同 ──────────────────────────────────────────
 *
 *   · **平台自有工具**(`TOOL_INDEX`):`purpose` = `PlatformTool.description` 原文。
 *   · **SDK 内置那 7 个**(read / grep / find / ls / edit / write / bash):平台注册表里
 *     没有它们(SDK 提供实现),SDK 给的描述是英文。这里补一句中文 —— 它就是
 *     「平台对这一层的说明」,不是从别处抄的;漏了会在 `tests/platform/tool-briefs.test.ts`
 *     的覆盖判据上当场红。
 */
import {
  capabilityGroup, isSdkToolName, type SdkToolName, type ToolName,
} from "../harness/capability.js";
import { capabilityOfTool } from "../harness/authorize.js";
import { TOOL_INDEX } from "./registry.js";
import type { ToolBriefView } from "@shared/types/platform.js";

/**
 * 类型列里「不知道属于哪一组」的兜底。
 *
 * ⚠️ 它不该出现在正常读面上:能进工具面的名字都来自闭合集,而闭合集的每一条
 * 都在 `CAPABILITY_TOOLS` 里。真出现说明**能力↔工具表与工具面脱节**了 ——
 * 那时如实写「未分类」,不编一个分组。
 */
const UNKNOWN_GROUP = "未分类";

/** 平台工具的 `description` 缺失时(注册表里没有这个名字)—— 缺陷,如实说。 */
const NO_BRIEF = "（工具表里没有这个名字的说明 —— 这是一条缺陷,不是「它没有作用」）";

/**
 * SDK 内置 7 个的中文一句。
 *
 * 语义逐条对着 SDK 的实现写的(`node_modules/@earendil-works/pi-coding-agent/dist/core/tools/*.js`
 * 的 `description`),不是凭名字猜的 —— 例如 `find` 是按 **glob 找文件路径**、
 * `grep` 才是按**正则搜内容**,两者写反了用户会照着错的去找。
 */
export const SDK_TOOL_PURPOSE: Readonly<Record<SdkToolName, string>> = {
  read: "读文件正文(文本与图片);大文件按 offset / limit 续读,一次读不完。",
  grep: "在文件**内容**里按正则检索,返回文件路径与行号(遵守 .gitignore)。",
  find: "按 glob 找**文件路径**(如 src/**/*.ts,遵守 .gitignore)。",
  ls: "列目录内容(含隐藏文件;目录带 / 后缀)。",
  edit: "对单个文件做精确文本替换(每处 oldText 必须唯一、互不重叠)。",
  write: "写整个文件:不存在则创建,存在则覆盖(自动建父目录)。",
  bash: "在工作目录执行 shell 命令,返回 stdout / stderr(超长输出截断)。",
};

/** 一个工具的类型 / 名称 / 作用。 */
export function toolBrief(name: ToolName): ToolBriefView {
  const capability = capabilityOfTool(name);
  if (isSdkToolName(name)) {
    return {
      name,
      source: "sdk",
      // SDK 内置工具**全部**挂在 `code.*` 能力下(`read/grep/find/ls` → code.read 等),
      // 所以这里查得到;查不到时如实写「—」,不编一个能力名。
      capability: capability ?? "—",
      group: capability !== undefined ? capabilityGroup(capability) : UNKNOWN_GROUP,
      purpose: SDK_TOOL_PURPOSE[name],
    };
  }
  const registered = TOOL_INDEX.get(name);
  return {
    name,
    source: "platform",
    capability: capability ?? "—",
    group: capability !== undefined ? capabilityGroup(capability) : UNKNOWN_GROUP,
    // 注册表里没有 ⇒ 这个名字进了工具面却没有实现。如实说,不退化成空串
    // (空串在表格里与「这个工具没事可做」长得一模一样)。
    purpose: registered !== undefined ? registered.description : NO_BRIEF,
  };
}

/**
 * 一批工具的类型 / 名称 / 作用,**顺序与入参一致**。
 *
 * 保序是判据的一部分:界面按 `RoleHarnessView.tools` 的顺序画表(那份名单本身
 * 由 `expandCapabilities` 按能力顺序稳定输出),两处顺序一致才不用在界面上再排一次。
 */
export function toolBriefs(names: readonly ToolName[]): ToolBriefView[] {
  return names.map((n) => toolBrief(n));
}
