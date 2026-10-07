/**
 * 工具面表格:类型 · 名称 · 作用。
 *
 * 用户的原话(2026-10-08):
 *
 *   「工具 做一个表格,按照类型、名称、作用来,现在搞一对英文名称的 list,
 *     完全不知道都有些啥」
 *
 * 所以这里把 `RoleHarnessView.tools` 那一串英文名换掉 —— 三列各回答一个问题:
 *
 *   类型  这个工具属于哪一类组织动作(项目 / 工作项 / 协作 / 工件 / …)。
 *         它**不是**授权单位,授权单位是能力 id(`blackboard.read`),悬停给出。
 *   名称  工具名本身 —— 模型调的就是它,所以它必须原样出现(不能只给中文译名)。
 *         另有「SDK 内置」pill 标出那不是平台实现的工具(读文件 / 跑 shell 那一类)。
 *   作用  平台注册表里**写给模型的那段说明原文**(`PlatformTool.description`)。
 *         刻意不重写成一句更好读的话:改写等于在这里造第二份真相,而两份漂开时
 *         「界面说的」与「模型拿到的」不一样,屏幕上完全看不出来(见 `tools/briefs.ts`)。
 *
 * ⚠️ **一份说明都没有时不许画空表**。`briefs` 为空 = 这一份读面没带说明
 * (旧后端,字段缺席),调用方要退化回「一串英文名」的老形状 —— 由调用方决定,
 * 本组件只负责画有内容的那张表(`length === 0` 返回 `null`)。
 */
import type { ToolBriefView } from "@shared/types/platform";
import { Markdown } from "@/components/chat/Markdown";

export function ToolTable({ briefs }: { briefs: readonly ToolBriefView[] }) {
  if (briefs.length === 0) return null;
  return (
    <table className="ss-table">
      <thead>
        <tr>
          <th>类型</th>
          <th>名称</th>
          <th>作用</th>
        </tr>
      </thead>
      <tbody>
        {briefs.map((b) => (
          <tr key={b.name}>
            <td
              className="ss-table-group"
              title={`能力 ${b.capability} —— 类型只是界面上的归类;ceiling 与授权判定用的是能力 id`}
            >
              {b.group}
            </td>
            <td className="ss-table-name" title={b.source === "sdk"
              ? "Pi SDK 内置工具:实现由 SDK 提供,平台只决定「给不给这个角色」"
              : "平台自有工具:实现与说明都在平台的工具注册表里"}
            >
              {b.name}
              {b.source === "sdk" && (
                <span className="ss-pill" data-tone="mute" style={{ marginLeft: 4 }}>
                  SDK 内置
                </span>
              )}
            </td>
            <td
              className="ss-table-purpose"
              title="平台写给模型的原文说明(不是为界面重写的文案)—— 界面照原样渲染,免得出现第二份会漂开的真相"
            >
              <Markdown text={b.purpose} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
