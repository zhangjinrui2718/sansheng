#!/usr/bin/env node
/**
 * Sansheng CLI · `sansheng start | stop | status | logs | reset | platform | version`
 * 单一可执行入口。`npm link` 或 `npx sansheng` 都能用。
 */
import { Command } from "commander";
import { runStart, runStop, runStatus, runLogs, runReset, dataDir } from "./commands.js";
import { runPlatformSmoke, parseRole } from "../platform/cli/smoke.js";
import { runPlatformRun } from "../platform/cli/run.js";
import { PROJECT_ROLES } from "../platform/identity/role.js";

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

program
  .command("platform")
  .description(
    "新平台(BC0–BC7)的入口。目前只有一个子命令:smoke —— 拿真 provider 建一个真会话," +
      "验证接线成立(并对着 SDK 的实际激活名单校验工具面)。",
  )
  .command("smoke")
  .description("冒烟验证:真建会话 + 真发一句话,校验「声明 vs SDK 实际激活」。")
  .option("--role <role>", `用哪个角色跑(${PROJECT_ROLES.join(" | ")})`, "business_manager")
  .option("-p, --prompt <text>", "发什么话", "用一句话说明你是谁、你能做什么。")
  .option("--cwd <path>", "会话工作目录(代码工具的根)")
  .option("--data <path>", "数据目录(读 provider 配置;默认 ~/.sansheng)")
  .option("--keep-temp", "保留临时库目录(排查用)", false)
  .option("--timeout <ms>", "回答等待上限(毫秒)", "120000")
  .action(async (opts: {
    role: string; prompt: string; cwd?: string; data?: string;
    keepTemp: boolean; timeout: string;
  }) => {
    const role = parseRole(opts.role);
    if (role === null) {
      process.stderr.write(`未知角色「${opts.role}」—— 可选:${PROJECT_ROLES.join(" | ")}\n`);
      process.exitCode = 2;
      return;
    }
    const ok = await runPlatformSmoke({
      dataDir: opts.data ?? dataDir(),
      prompt: opts.prompt,
      role,
      cwd: opts.cwd ?? process.cwd(),
      keepTemp: opts.keepTemp,
      timeoutMs: Number(opts.timeout) || 120_000,
    });
    process.exitCode = ok ? 0 : 1;
  });

program
  .command("platform-run")
  .description(
    "跑一个工作项(BC6 执行层)。播种组织(幂等)→ 建项目 → 拆工作项 → 派给 worker → " +
      "真跑它 → 打印产出工件与工具调用现场。**写真实数据目录**。",
  )
  .requiredOption("-t, --task <text>", "要做什么(会成为工作项的目标)")
  .option("--project <id>", "已有项目 id;不给就新建一个")
  .option("--worker <id>", "指定 worker;不给就用第一个")
  .option("--cwd <path>", "会话工作目录(代码工具的根)")
  .option("--data <path>", "数据目录(默认 ~/.sansheng)")
  .option("--timeout <ms>", "回合等待上限(毫秒)", "300000")
  .action(async (opts: {
    task: string; project?: string; worker?: string;
    cwd?: string; data?: string; timeout: string;
  }) => {
    const ok = await runPlatformRun({
      dataDir: opts.data ?? dataDir(),
      task: opts.task,
      ...(opts.project !== undefined ? { projectId: opts.project } : {}),
      ...(opts.worker !== undefined ? { workerId: opts.worker } : {}),
      cwd: opts.cwd ?? process.cwd(),
      timeoutMs: Number(opts.timeout) || 300_000,
    });
    process.exitCode = ok ? 0 : 1;
  });

// default: sansheng (no args) → start in foreground
if (process.argv.length <= 2) {
  await runStart({ daemon: false, host: "127.0.0.1", port: "2718", open: false });
} else {
  await program.parseAsync(process.argv);
}