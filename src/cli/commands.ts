/**
 * Sansheng CLI commands implementation.
 * - start (foreground / daemon via spawn detached)
 * - stop, status, logs, reset
 *
 * PID file: ~/.sansheng/sansheng.pid
 * Log file:  ~/.sansheng/logs/sansheng.log
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync, openSync } from "node:fs";
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

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
      env: { ...process.env, SANSHENG_DATA: opts.data ?? dataDir(), SANSHENG_DAEMON: "1", PI_OFFLINE: "1" },
    });
    child.unref();
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
      const t = setTimeout(() => {
        process.stdin.removeListener("data", on);
        resolve(false);
      }, 5000);
      const on = (chunk: string) => {
        buf += chunk;
        if (buf.trim() === "yes") {
          clearTimeout(t);
          process.stdin.removeListener("data", on);
          resolve(true);
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