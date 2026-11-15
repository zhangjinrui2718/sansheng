// 端到端驱动:接待 → 立项 → 执行 → 交付 → 验收(全程记录事件与耗时)
import WebSocket from "ws";

const PORT = 2791;
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
const events = [];
let projectId = null;
const t0 = Date.now();
const ts = () => `[+${Math.round((Date.now() - t0) / 1000)}s]`;

ws.on("open", () => {
  process.stdout.write(`${ts()} WS 已连接,发送接待消息\n`);
  ws.send(JSON.stringify({
    type: "send",
    projectId: null,
    content: "就做一件事:写一份不超过 300 字的「三生平台」产品简介,交付一份 HTML 报告。不要再问我任何问题,直接做完交付。",
  }));
});

ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  events.push(ev);
  switch (ev.type) {
    case "project_opened":
      projectId = ev.projectId;
      process.stdout.write(`${ts()} ★ 立项:${ev.projectId} ${ev.name ?? ""}\n`);
      break;
    case "message_start":
      if (ev.source === "turn") process.stdout.write(`${ts()} 轮开始 agent=${ev.agentId} trigger=${ev.trigger?.kind ?? "?"}\n`);
      break;
    case "tool_start":
      process.stdout.write(`${ts()}   工具 ${ev.name}\n`);
      break;
    case "delta":
      break;
    case "agent_end":
      process.stdout.write(`${ts()} 轮结束\n`);
      break;
    case "overdue_asks":
      process.stdout.write(`${ts()} ★ overdue_asks 事件收到!count=${ev.count}\n`);
      break;
    case "error":
      process.stdout.write(`${ts()} ✖ error ${JSON.stringify(ev.error).slice(0, 200)}\n`);
      break;
  }
});

ws.on("error", (e) => process.stdout.write(`WS 错误:${e.message}\n`));

// 周期汇报状态
const report = setInterval(async () => {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/api/projects`);
    const j = await r.json();
    const ps = j.projects ?? [];
    const cur = ps.find((p) => p.id === projectId);
    if (cur) process.stdout.write(`${ts()} [状态] ${cur.name} · ${cur.status}\n`);
  } catch { /* 忽略 */ }
}, 20000);

// 总时长限制
setTimeout(() => {
  process.stdout.write(`${ts()} === 驱动结束 ===\n`);
  const kinds = {};
  for (const e of events) kinds[e.type] = (kinds[e.type] ?? 0) + 1;
  process.stdout.write(`事件统计:${JSON.stringify(kinds)}\n`);
  clearInterval(report);
  ws.close();
  process.exit(0);
}, 10 * 60_000);
