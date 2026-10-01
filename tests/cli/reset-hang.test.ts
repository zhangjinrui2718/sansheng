/**
 * Sansheng CLI · A8 回归:交互式 `sansheng reset` 确认后进程必须及时退出
 *
 * 缺陷(docs/CODE-REVIEW-2026-10-01.md §A8):
 *   commands.ts runReset 的确认路径 setRawMode(true)+resume() 后,两条 resolve
 *   路径(yes / 5s 超时)只 removeListener,从不 pause()/setRawMode(false) →
 *   flowing 状态的 stdin 是活跃 handle,挂住 event loop → 打印完结果后进程永不退出。
 *
 * 测试形态(报告取舍项):pty 在 vitest 中不稳定(node-pty 非依赖,禁新增),
 * 改用子进程 spawn + pipe stdin 复现同一 bug —— pipe 保持打开(不 end)时,
 * 旧代码 resolve 后 stdin 仍 flowing → 进程挂住;新代码 pause() → 及时退出。
 * setRawMode 在 pipe 上是 undefined(optional chain no-op),不影响复现:
 * 挂死的根因是 resume() 后的 flowing handle,与 raw mode 无关。
 */
import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(fileURLToPath(new URL(".", import.meta.url)), "..", "..");

describe("CLI reset (A8): 交互式确认后进程及时退出", () => {
  let child: ChildProcess | null = null;
  let tmp: string | null = null;

  afterEach(() => {
    try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    child = null;
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = null;
  });

  it("写入 yes 确认后:删除数据 + 8s 内退出(旧代码:stdin 仍 flowing → 永不退出)", async () => {
    tmp = mkdtempSync(join(tmpdir(), "sansheng-reset-hang-"));
    const settingsPath = join(tmp, "settings.json");
    writeFileSync(settingsPath, "{}");

    child = spawn(
      process.execPath,
      ["--import", "tsx", "src/cli/index.ts", "reset"],
      {
        cwd: repoRoot,
        env: { ...process.env, SANSHENG_DATA: tmp },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    child.stdout?.on("data", (d) => { stdout += d.toString(); });
    child.stderr?.on("data", (d) => { stdout += d.toString(); });

    // pipe 缓冲:子进程 resume() 后即可读到。不 end() —— 保持 handle 活跃,
    // 精确复现 TTY 场景的挂死条件(旧代码 removeListener 后 stdin 仍 flowing)。
    child.stdin?.write("yes\n");

    const exited = await new Promise<boolean>((resolveExit) => {
      const deadline = setTimeout(() => resolveExit(false), 8_000);
      child?.on("exit", () => {
        clearTimeout(deadline);
        resolveExit(true);
      });
      child?.on("error", () => {
        clearTimeout(deadline);
        resolveExit(false);
      });
    });

    if (!exited) {
      // RED 证据:确认已完成(reset complete 已打印)但进程仍挂着
      try { child?.kill("SIGKILL"); } catch { /* ignore */ }
    }

    expect(
      exited,
      `确认 yes 后进程未在 8s 内退出(A8:stdin 未 pause,flowing handle 挂住 event loop)。输出尾部:${stdout.slice(-200)}`,
    ).toBe(true);
    expect(stdout).toContain("reset complete");
    expect(existsSync(settingsPath)).toBe(false);
  }, 30_000);
});
