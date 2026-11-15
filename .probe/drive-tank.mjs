// 二战坦克塔防:接待 → 全链路(事件记录 15 分钟,之后转 HTTP 轮询)
import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:2791/ws");
const t0 = Date.now();
const ts = () => `[+${Math.round((Date.now() - t0) / 1000)}s]`;
let projectId = null;
ws.on("open", () => {
  process.stdout.write(`${ts()} 发单\n`);
  ws.send(JSON.stringify({
    type: "send",
    projectId: null,
    content: "我想做一款二战背景的坦克塔防游戏,先做能玩的网页版 v1:玩家在地图上布置反坦克炮阵地,抵御一波波德军坦克进攻,有金币、波次、胜负。就用单个自包含 HTML 文件(打开即玩,不要外链资源)。这是第一版,能玩就行,但核心循环必须真的能转起来。直接开工做完交付,不用反复问我。",
  }));
});
ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === "project_opened") {
    projectId = ev.projectId;
    process.stdout.write(`${ts()} ★ 立项 ${ev.projectId}\n`);
  } else if (ev.type === "tool_start") {
    process.stdout.write(`${ts()} 工具 ${ev.tool?.name ?? "?"}\n`);
  } else if (ev.type === "message_start" && ev.source === "turn") {
    process.stdout.write(`${ts()} 轮 ${ev.agentId} (${ev.trigger?.kind ?? "?"})\n`);
  } else if (ev.type === "overdue_asks") {
    process.stdout.write(`${ts()} ★ overdue_asks count=${ev.count}\n`);
  } else if (ev.type === "error") {
    process.stdout.write(`${ts()} ✖ ${JSON.stringify(ev.error).slice(0, 160)}\n`);
  }
});
ws.on("error", (e) => process.stdout.write("WS错误 " + e.message + "\n"));
setTimeout(() => { process.stdout.write(`${ts()} 观察窗结束(转 HTTP 轮询)\n`); process.exit(0); }, 15 * 60_000);
