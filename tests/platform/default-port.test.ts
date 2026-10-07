/**
 * 默认端口:**一处真相,五处写法** —— 它们曾经漂过,所以这里钉住
 *
 * 2026-10-08 之前:`platform-serve` 的默认是 **2719**,而 `vite.config.ts` 的 proxy 指向
 * **2718**。两边各写一个数字,后果是「dev 起得来、界面连不上」—— 而屏幕上只有一句
 * 「连不上」,看不出是端口写错了(AGENTS.md 里那句话就是这么来的)。
 *
 * 用户随后把默认端口统一成 **2718**。这条测试是那道防线,与
 * `tests/web/role-names.test.ts`(角色中文名三处逐项对照)同一形态:
 * **同一件事写在多个文件里,就必须有一条机器对照** —— 否则它迟早再漂一次,
 * 而且同样是漂到没人看得出。
 *
 * ⚠️ 每个正则都**自检**了「必须捕获到数字」:模式写坏时不能静默 0 命中然后全绿
 * (本项目列在案的第 3 类静默失败:检查本身返回一个看起来正常的错误答案)。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "../..");
const read = (rel: string): string => readFileSync(join(ROOT, rel), "utf8");

/** 抓一个数字;**抓不到就红** —— 不许静默通过。 */
function grab(source: string, pattern: RegExp, what: string): string {
  const m = pattern.exec(source);
  expect(m, `${what}:模式没匹配到任何东西(检查器自己坏了,不是代码对了)`).not.toBeNull();
  return m![1]!;
}

describe("默认端口:五处写法必须逐字相同", () => {
  it("CLI 的三处 + vite 的两个 proxy 目标 = 同一个数字", () => {
    const cli = read("src/cli/index.ts");
    const vite = read("vite.config.ts");

    const optionDefault = grab(cli, /--port <port>", "端口", "(\d+)"/, "CLI 选项默认值");
    const runtimeFallback = grab(cli, /Number\(opts\.port\) \|\| (\d+)/, "CLI 显式传参的回退值");
    const noArgs = grab(cli, /host: "127\.0\.0\.1",\s*\n\s*port: (\d+),/, "无参数启动的默认值");
    const proxyHttp = grab(vite, /target: "http:\/\/127\.0\.0\.1:(\d+)"/, "vite 的 /api 代理目标");
    const proxyWs = grab(vite, /target: "ws:\/\/127\.0\.0\.1:(\d+)"/, "vite 的 /ws 代理目标");

    const all = { optionDefault, runtimeFallback, noArgs, proxyHttp, proxyWs };
    const port = optionDefault;
    for (const [what, value] of Object.entries(all)) {
      expect(value, `${what} 与 CLI 默认值不一致(默认端口又漂了)`).toBe(port);
    }
    // 正样本自检:确实抓到了一个像端口的四位数(而不是抓到了 "5173" 这种)
    expect(Number(port)).toBeGreaterThan(1024);
    expect(Number(port)).toBeLessThan(65536);
  });

  it("现状文档里写的默认端口与代码一致(文档不许撒谎)", () => {
    const cli = read("src/cli/index.ts");
    const port = grab(cli, /--port <port>", "端口", "(\d+)"/, "CLI 选项默认值");
    for (const [file, pattern] of [
      ["AGENTS.md", /- 默认 `127\.0\.0\.1:(\d+)`;/],
      ["README.md", /→ http:\/\/127\.0\.0\.1:(\d+)/],
    ] as const) {
      const src = read(file);
      expect(grab(src, pattern, `${file} 的默认端口`), `${file} 写的默认端口与代码不一致`).toBe(port);
    }
  });
});
