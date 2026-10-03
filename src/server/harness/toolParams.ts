/**
 * Sansheng Harness · sansheng 自家工具的参数清单(批次 8-F)
 *
 * 为什么要它:8-F 的实机事故是「执行者调 bash 传错了参数名 → `/bin/bash: undefined`」,
 * 根因是**协议段只渲染工具名与一句描述,从不告诉模型参数叫什么**。SDK 那 7 个工具的
 * 参数从它们自带的 typebox schema 取(sdkTools.ts),而 canvas_ / net_ / board_ / memory_search
 * 这 9 个是 sansheng 自己写的,没有 schema 可取 —— 只能在这里手写。
 *
 * **这一张表就是「模型看得见的 API 文档」**。改了任一工具的入参名,这里必须同步改,
 * 否则用户会看到「工具明明有,却总是失败」。tools/agents 的测试会做基本存在性校验。
 */
import type { LoopToolParam } from "../agents/toolLoop.js";

export const TOOL_PARAM_HINTS: Readonly<Record<string, readonly LoopToolParam[]>> = {
  // ── canvas_*(sandbox 允许根内)──
  canvas_read: [
    { name: "path", required: true, description: "sandbox 允许根内的文件路径" },
  ],
  canvas_list: [
    { name: "path", required: true, description: "sandbox 允许根内的目录路径" },
  ],
  canvas_stat: [
    { name: "path", required: true, description: "sandbox 允许根内的路径" },
  ],
  canvas_write: [
    { name: "path", required: true, description: "要写的文件路径" },
    { name: "content", required: true, description: "完整文件内容(整file覆写)" },
  ],
  // ── net_*(受 net.json allowlist 限制)──
  net_fetch: [
    { name: "url", required: true, description: "allowlist 内的完整 URL(必须带 http/https)" },
  ],
  net_post: [
    { name: "url", required: true, description: "allowlist 内的完整 URL" },
    { name: "body", required: true, description: "要发送的 JSON 请求体(字符串)" },
  ],
  // ── Blackboard 原语 ──
  board_list: [
    { name: "kind", required: false, description: "按工件类型过滤,如 todo/evidence/hypothesis/decision/note" },
    { name: "status", required: false, description: "按状态过滤,如 open/in_progress/resolved/failed" },
    { name: "limit", required: false, description: "返回条数上限(默认 20)" },
  ],
  board_read: [
    { name: "id", required: true, description: "工件 id(board_list 的结果里带 id=)" },
  ],
  // ── 长期记忆 ──
  memory_search: [
    { name: "query", required: true, description: "要检索的关键词或一句话描述" },
    { name: "limit", required: false, description: "返回条数上限(默认 3)" },
  ],
};