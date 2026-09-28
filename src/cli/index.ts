#!/usr/bin/env node
/**
 * Sansheng CLI · `sansheng start | stop | status | logs | reset | version`
 * 单一可执行入口。`npm link` 或 `npx sansheng` 都能用。
 */
import { Command } from "commander";
import { runStart, runStop, runStatus, runLogs, runReset } from "./commands.js";

const program = new Command();

program
  .name("sansheng")
  .description("三生 · A digital robot employee. Token is salary; work is output.")
  .version("0.1.0");

program
  .command("start")
  .description("Start the Sansheng service (Hono HTTP + WebSocket on :2718).")
  .option("-d, --daemon", "Run in background, return immediately.", false)
  .option("--host <host>", "Bind host (default 127.0.0.1).", "127.0.0.1")
  .option("-p, --port <port>", "Bind port (default 2718).", "2718")
  .option("--data <path>", "Data directory (default ~/.sansheng).")
  .option("--open", "open web UI in browser after start", false)
  .action(async (opts) => {
    await runStart(opts);
  });

program
  .command("stop")
  .description("Stop the running Sansheng daemon.")
  .action(async () => {
    await runStop();
  });

program
  .command("status")
  .description("Show Sansheng daemon status (pid, uptime, port).")
  .action(async () => {
    await runStatus();
  });

program
  .command("logs")
  .description("Tail Sansheng daemon logs.")
  .option("-n, --lines <n>", "Lines to show", "80")
  .option("-f, --follow", "Follow log output", false)
  .action(async (opts) => {
    await runLogs(opts);
  });

program
  .command("reset")
  .description("Wipe Sansheng data directory (with confirmation).")
  .option("-y, --yes", "Skip confirmation", false)
  .action(async (opts) => {
    await runReset(opts);
  });

// default: sansheng (no args) → start in foreground
if (process.argv.length <= 2) {
  await runStart({ daemon: false, host: "127.0.0.1", port: "2718", open: false });
} else {
  await program.parseAsync(process.argv);
}