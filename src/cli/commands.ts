/**
 * Sansheng CLI commands implementation.
 * - start (foreground / daemon via spawn detached)
 * - stop, status, logs, reset
 *
 * PID file: ~/.sansheng/sansheng.pid
 * Log file:  ~/.sansheng/logs/sansheng.log
 */
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { log } from "../shared/log.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = import.meta.dirname ?? join(__filename, "..");

// 默认数据目录 ~/.sansheng，可用 sansheng config data <path> 覆盖
export function dataDir(): string {
  if (process.env.SANSHENG_DATA) return process.env.SANSHENG_DATA;
  return join(homedir(), ".sansheng");
}

const PID_FILE = () => join(dataDir(), "sansheng.pid");
const LOG_FILE = () => join(dataDir(), "logs", "sansheng.log");

export function ensureDirs(): void {
  const d = dataDir();
  if (!existsSync(d)) mkdirSync(d, { recursive: true });
  const logs = join(d, "logs");
  if (!existsSync(logs)) mkdirSync(logs, { recursive: true });
}

export function readPid(): number | null {
  try {
    const p = readFileSync(PID_FILE(), "utf-8").trim();
    const n = Number(p);
    if (!Number.isFinite(n)) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * B10-6:进程退出时清理自己的 pid 文件 —— 仅当文件内容指向本进程才删,
 * 避免误删「新实例刚写入的 pid」。index.ts 在 exit/SIGINT/SIGTERM 路径调用。
 */
export function clearOwnPidFile(): void {
  try {
    if (readPid() === process.pid) rmSync(PID_FILE());
  } catch { /* ignore */ }
}

/**
 * B10-6:进程名身份校验(纯函数,便于单测)。
 * macOS/Linux 的 `ps -o comm=` 给出可执行文件完整路径
 * (如 /opt/homebrew/Cellar/node/26/bin/node),含 "node" 即认为是本项目的 daemon。
 * 已知取舍:pid 被另一个无关 node 进程复用时仍会误判(见报告 open question)。
 */
export function isNodeComm(comm: string | null): boolean {
  if (!comm) return false;
  return comm.includes("node");
}

/** B10-6:读取 pid 的可执行文件路径;死 pid / 查询失败 → null。 */
export function readPidComm(pid: number): string | null {
  try {
    const out = execFileSync("ps", ["-p", String(pid), "-o", "comm="], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const comm = out.trim();
    return comm.length > 0 ? comm : null;
  } catch {
    return null;
  }
}

/**
 * B10-6:pid 存活 + 身份校验。
 * 旧实现只做 process.kill(pid,0):stale pid 文件里的 pid 被无关进程复用时
 * 误判「在跑」→ runStop 会对无关进程 SIGTERM→SIGKILL(杀错进程)。
 * 现在额外要求 comm 含 "node" 才算 sansheng daemon 活着。
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  return isNodeComm(readPidComm(pid));
}

/**
 * 批次 4b C11(审查 §C11「daemon 强制 PI_OFFLINE=1 覆盖用户显式值」):
 * daemon 子进程的环境变量。
 *
 * 旧实现无条件写 `PI_OFFLINE: "1"`,覆盖用户在 shell 里显式设的 `PI_OFFLINE=0` ——
 * 而前台 `sansheng start` 走 index.ts 的
 * `process.env.PI_OFFLINE = process.env.PI_OFFLINE ?? "1"`,**尊重**用户值。
 * 同一份配置两种行为:用户明明要联网跑,`-d` 起的后台进程却在离线模式。
 *
 * 契约:缺省才补 "1"(离线仍是无网络环境下的安全默认),显式值(含 "0")原样传递,
 * 前台 / daemon 行为一致。纯函数:不修改传入的 base。
 */
export function buildDaemonEnv(
  base: NodeJS.ProcessEnv,
  dataDirPath: string,
): NodeJS.ProcessEnv {
  return {
    ...base,
    SANSHENG_DATA: dataDirPath,
    SANSHENG_DAEMON: "1",
    // 与 index.ts 同款「缺省才补」语义
    PI_OFFLINE: base.PI_OFFLINE ?? "1",
  };
}

export interface WaitForHealthOptions {
  /** 总超时(默认 10s) */
  timeoutMs?: number;
  /** 轮询间隔(默认 250ms) */
  intervalMs?: number;
  /** 每轮探测前调用;返回 true(daemon 子进程已早死)→ 立即放弃返回 false */
  isAborted?: () => boolean;
}

/**
 * B10-6:轮询健康端点直到 HTTP 200 或超时。
 * start -d 专用:旧实现 spawn 后不探测即写 pid + 报 ok —— 子进程秒死
 * (EADDRINUSE / dist 缺失 / 配置崩溃)时用户拿到假成功 + 僵尸 pid 文件。
 * 用全局 fetch(Node ≥18),无新依赖;拒连/非 200 都视为未就绪继续轮询。
 */
export async function waitForHealth(url: string, opts: WaitForHealthOptions = {}): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const intervalMs = opts.intervalMs ?? 250;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (opts.isAborted?.()) return false;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(Math.max(500, intervalMs * 2)) });
      if (res.status === 200) return true;
    } catch {
      // 拒连 / 单次请求超时 —— daemon 还没就绪,继续轮询
    }
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

export interface StartOptions {
  daemon: boolean;
  host: string;
  port: string;
  open: boolean;
  data?: string;
}

/**
 * 启动 sansheng。前台直接启动 server；后台用 spawn detached fork 子进程。
 */
export async function runStart(opts: StartOptions): Promise<void> {
  ensureDirs();

  const existing = readPid();
  if (existing && isAlive(existing)) {
    log.warn(`Sansheng already running (pid=${existing}). Run \`sansheng stop\` first.`);
    process.exitCode = 2;
    return;
  }
  if (existing && !isAlive(existing)) {
    log.warn(`Stale pid file (pid=${existing} dead). Cleaning up.`);
    try {
      rmSync(PID_FILE());
    } catch {}
  }

  const entry = join(__dirname, "..", "server", "index.js");
  const logFd = openSync(LOG_FILE(), "a");

  if (opts.daemon) {
    // detach 子进程: stdin/out 切断，进程独立 session
    const child = spawn(process.execPath, [entry, "--host", opts.host, "--port", opts.port], {
      detached: true,
      stdio: ["ignore", logFd, logFd],
      env: buildDaemonEnv(process.env, opts.data ?? dataDir()),
    });
    child.unref();
    // B10-6:早死检测 —— 子进程在健康检查通过前 exit(EADDRINUSE / dist 缺失 /
    // 配置崩溃)时,waitForHealth 经 isAborted 立即放弃,不再假报成功。
    let childExited = false;
    child.on("exit", () => {
      childExited = true;
    });
    // 0.0.0.0/:: 绑定所有接口 → 健康探测走 loopback
    const healthHost = opts.host === "0.0.0.0" || opts.host === "::" ? "127.0.0.1" : opts.host;
    const healthUrl = `http://${healthHost}:${opts.port}/api/health`;
    const healthy = await waitForHealth(healthUrl, {
      timeoutMs: 10_000,
      intervalMs: 250,
      isAborted: () => childExited,
    });
    // 父进程不再需要 log fd(子进程持有自己的 dup)
    try { closeSync(logFd); } catch { /* ignore */ }
    if (!healthy) {
      // 子进程还活着但不健康(如卡在启动)→ 回收,不留半死进程
      if (!childExited && child.pid) {
        try { process.kill(child.pid, "SIGTERM"); } catch { /* ignore */ }
      }
      log.error(
        `Sansheng failed to start: ${healthUrl} 未在 10s 内就绪${childExited ? "(子进程已提前退出)" : ""}。`,
      );
      log.muted(`查看日志: ${LOG_FILE()}`);
      process.exitCode = 1;
      return;
    }
    // B10-6:pid 只在健康检查通过后写入 —— 不再出现「报 ok 但 pid 指向死进程」
    writeFileSync(PID_FILE(), String(child.pid ?? ""));
    log.ok(`Sansheng started (pid=${child.pid}) on http://${opts.host}:${opts.port}`);
    log.muted(`log: ${LOG_FILE()}`);
    log.muted(`pid: ${PID_FILE()}`);
    if (opts.open) {
      try {
        const { default: opener } = await import("open");
        await opener(`http://${opts.host}:${opts.port}`);
      } catch {
        log.warn("failed to open browser; please navigate manually.");
      }
    }
    return;
  }

  // 前台模式：直接转发到 server 模块
  // 把 args 通过 env 传递（避免 argv 冲突）
  process.env.SANSHENG_HOST = opts.host;
  process.env.SANSHENG_PORT = opts.port;
  process.env.SANSHENG_DATA = opts.data ?? dataDir();
  if (opts.open) process.env.SANSHENG_OPEN = "1";
  // 写入 PID（前台也写，方便 status 命令识别）
  writeFileSync(PID_FILE(), String(process.pid));
  const { startServer } = await import("../server/index.js");
  await startServer({ host: opts.host, port: Number(opts.port), dataDir: opts.data ?? dataDir() });
}

export async function runStop(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    log.warn("No pid file found. Sansheng not running?");
    return;
  }
  if (!isAlive(pid)) {
    log.warn(`pid=${pid} not alive. Cleaning pid file.`);
    try {
      rmSync(PID_FILE());
    } catch {}
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    log.ok(`Sent SIGTERM to pid=${pid}.`);
    // 等待 5 秒，否则 SIGKILL
    const deadline = Date.now() + 5000;
    while (isAlive(pid) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (isAlive(pid)) {
      process.kill(pid, "SIGKILL");
      log.warn(`pid=${pid} didn't exit; sent SIGKILL.`);
    }
    try {
      rmSync(PID_FILE());
    } catch {}
  } catch (err) {
    log.error(`failed to stop pid=${pid}:`, err);
  }
}

export async function runStatus(): Promise<void> {
  const pid = readPid();
  if (!pid) {
    log.muted("not running (no pid file)");
    return;
  }
  if (!isAlive(pid)) {
    log.muted(`pid=${pid} not alive`);
    return;
  }
  const started = readStartTime();
  const uptime = started ? Math.floor((Date.now() - started) / 1000) : 0;
  log.ok(`running · pid=${pid} · uptime=${uptime}s`);
}

function readStartTime(): number | null {
  try {
    return statSync(PID_FILE()).birthtimeMs;
  } catch {
    return null;
  }
}

export async function runLogs(opts: { lines: string; follow: boolean }): Promise<void> {
  const path = LOG_FILE();
  if (!existsSync(path)) {
    log.warn(`no log file at ${path}`);
    return;
  }
  const { spawn } = await import("node:child_process");
  const args = ["-n", opts.lines];
  if (opts.follow) args.push("-f");
  const tail = spawn("tail", [...args, path], { stdio: "inherit" });
  await new Promise<void>((resolve) => {
    tail.on("exit", () => resolve());
  });
}

export async function runReset(opts: { yes: boolean }): Promise<void> {
  const d = dataDir();
  if (!opts.yes) {
    log.warn(`About to wipe data files in ${d} (logs kept)`);
    log.warn(`Type 'yes' within 5s to confirm:`);
    process.stdin.setRawMode?.(true);
    process.stdin.resume();
    process.stdin.setEncoding("utf8");
    const ok = await new Promise<boolean>((resolve) => {
      let buf = "";
      // A8:确认/超时两条 resolve 路径都必须恢复 stdin 状态 ——
      // resume() 让 stdin 进入 flowing 模式,active handle 会挂住 event loop:
      // reset 跑完后进程永不退出(实证:输出 "reset complete" 后 hang 8s+ 不退出)。
      // pause() 停读 + setRawMode(false) 恢复 TTY 规范模式(管道下均为安全 no-op);
      // 管道 stdin 一旦被 resume 过,pause() 不足以 deref(实证仍挂住),
      // 还需 unref() 把 handle 从 event loop 引用中摘除,进程才能自然退出。
      const finish = (v: boolean) => {
        process.stdin.removeListener("data", on);
        process.stdin.pause();
        process.stdin.setRawMode?.(false);
        process.stdin.unref?.();
        resolve(v);
      };
      const t = setTimeout(() => finish(false), 5000);
      const on = (chunk: string) => {
        buf += chunk;
        if (buf.trim() === "yes") {
          clearTimeout(t);
          finish(true);
        }
      };
      process.stdin.on("data", on);
    });
    if (!ok) {
      log.warn("aborted.");
      return;
    }
  }

  // M2:精细化删除(留 logs)— 与 /api/reset 保持一致
  const targets = [
    join(d, "sansheng.db"),
    join(d, "sansheng.db-wal"),
    join(d, "sansheng.db-shm"),
    join(d, ".keyring"),
    join(d, "settings.json"),
    join(d, "pi"),
  ];
  const removed: string[] = [];
  for (const t of targets) {
    try {
      if (existsSync(t)) {
        rmSync(t, { recursive: true, force: true });
        removed.push(t);
        log.muted(`  removed: ${t}`);
      }
    } catch (err) {
      log.warn(`failed to remove ${t}:`, err);
    }
  }
  log.ok(`reset complete (${removed.length} paths removed). logs/ kept.`);
}