/**
 * Sansheng Harness · skills facet(未实现占位)
 *
 * **本文件故意只有一个壳。** 它存在的意义是让「五项管理」的缺口在管理面里
 * **显式可见**,而不是让用户以为系统没有这一项 —— 与 7-E 拒绝给无工具循环的
 * 角色编一份非空出厂名单是同一条原则。
 *
 * 现状(批次 7-G 时经 grep 核实):`grep -rn "skill" src/ shared/` **零命中** ——
 * sansheng 没有任何 skill 概念。SDK 侧倒是有现成的:`loadSkills` /
 * `formatSkillsForPrompt` / `Skill` 类型都在 `@earendil-works/pi-coding-agent`
 * 的导出里,且 `DefaultResourceLoader` 已经在用(communicator 的 append 文件发现)。
 *
 * 将来实现时要填的四件事(不是本文件的事,记在这里免得重新调研):
 *   1. 落盘格式:倾向 `harness/skills/{name}/SKILL.md`(与 SDK 的目录式发现对齐,
 *      直接复用 `loadSkills` 而不是自己写解析)。
 *   2. 授权:skill 本身是**提示词**,不是工具 —— 它不突破任何 ceiling,但
 *      「哪个 agent 能加载哪些 skill」需要一个与 `ROLE_CEILING` 同构的上界
 *      (否则用户能让 executor 加载一个教它写文件的 skill)。
 *   3. 注入点:`DefaultResourceLoader` 的发现路径,或 system prompt 追加段。
 *   4. 生效时机:与 prompt 单元同款「下次 session 重建」,但要**显式写进
 *      PROMPT_UNIT 那样的 apply 字段**,不能含糊。
 */
import type { HarnessFacet } from "../facet.js";

export const skillsFacet: HarnessFacet = {
  id: "skills",
  title: "技能",
  implemented: false,
  notImplementedNote:
    "未实现:src/ 里 skill 零命中,系统当前没有 skill 概念。SDK 侧 loadSkills / formatSkillsForPrompt / Skill 已就绪,是纯待做项 —— 本行存在的意义是让缺口可见,不是占位凑数。",
  ensure() {
    // 未实现 → 不写任何出厂文件。编一份空壳目录才是真的造假。
  },
  describe() {
    // 未实现 → 返回空条目。**不编造示例技能** —— 页面上的假数据比没有更糟。
    return [];
  },
};
