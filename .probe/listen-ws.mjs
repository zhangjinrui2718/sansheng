// 只听不发的 WS 观察器(90 秒)
import WebSocket from "ws";
const ws = new WebSocket("ws://127.0.0.1:2791/ws");
const t0 = Date.now();
ws.on("open", () => process.stdout.write("LISTEN open\n"));
ws.on("message", (raw) => {
  const ev = JSON.parse(raw.toString());
  if (ev.type === "overdue_asks" || ev.type === "pong") {
    process.stdout.write(`EVENT ${ev.type} ${JSON.stringify(ev).slice(0, 120)}\n`);
  }
});
ws.on("error", (e) => process.stdout.write("WS错误 " + e.message + "\n"));
setTimeout(() => process.exit(0), 90_000);
