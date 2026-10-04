#!/usr/bin/env node
/**
 * Sansheng CLI · `sansheng start | stop | status | logs | reset | platform | version`
 * 单一可执行入口。`npm link` 或 `npx sansheng` 都能用。
 */
import { Command } from "commander";
import { dataDir } from "./paths.js";
import { runPlatformSmoke, parseRole } from "../platform/cli/smoke.js";
import { runPlatformRun } from "../platform/cli/run.js";
import { runPlatformServe } from "../platform/host/serve.js";
import { PROJECT_ROLES } from "../platform/identity/role.js";

const program = new Command();

program
  .name("sansheng")
  .description("三生 · A digital robot employee. Token is salary; work is output.")
  .version("0.1.0");

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

program
  .command("platform-serve")
  .description(
    "起平台服务(HTTP + WS + 托管前端)。这是新架构的常驻宿主 —— " +
      "界面能用、client.* 闭环、调度器有地方待,三件事都依赖它。",
  )
  .option("--host <host>", "绑定地址", "127.0.0.1")
  .option("-p, --port <port>", "端口", "2719")
  .option("--cwd <path>", "会话工作目录(代码工具的根)")
  .option("--data <path>", "数据目录(默认 ~/.sansheng)")
  .option("--open", "起好后打开浏览器", false)
  .option(
    "--max-cascade-rounds <n>",
    "单次级联最多跑几个 agent 回合(烧 token 的硬上界;默认 8)",
    "8",
  )
  .option(
    "--scheduler-interval <ms>",
    "超时提问扫描间隔(毫秒;默认 60000)",
    "60000",
  )
  .option(
    "--dispatch-interval <ms>",
    "排空器兜底定时器间隔(毫秒,fixed-delay;默认 10000)",
    "10000",
  )
  .action(async (opts: {
    host: string; port: string; cwd?: string; data?: string; open: boolean;
    maxCascadeRounds: string; schedulerInterval: string; dispatchInterval: string;
  }) => {
    const rounds = Number(opts.maxCascadeRounds);
    const interval = Number(opts.schedulerInterval);
    const dispatchInterval = Number(opts.dispatchInterval);
    await runPlatformServe({
      dataDir: opts.data ?? dataDir(),
      host: opts.host,
      port: Number(opts.port) || 2719,
      ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
      version: "0.1.0",
      open: opts.open,
      // 非法值不静默退回默认 —— 那会让「我调了上界」和「它根本没生效」长得一样
      maxCascadeRounds: Number.isFinite(rounds) && rounds > 0 ? rounds : 8,
      schedulerIntervalMs: Number.isFinite(interval) && interval > 0 ? interval : 60_000,
      dispatchIntervalMs:
        Number.isFinite(dispatchInterval) && dispatchInterval > 0 ? dispatchInterval : 10_000,
    });
  });

// 无参数 → 起平台服务(旧的「无参数起 daemon」随旧系统一起删了)
if (process.argv.length <= 2) {
  await runPlatformServe({
    dataDir: dataDir(),
    host: "127.0.0.1",
    port: 2719,
    version: "0.1.0",
    open: false,
  });
} else {
  await program.parseAsync(process.argv);
}