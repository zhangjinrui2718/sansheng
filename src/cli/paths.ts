/**
 * CLI · 路径
 *
 * `dataDir()` 原本住在 `src/cli/commands.ts` 里,而那个文件是旧 daemon 的
 * 命令实现(start / stop / status / logs / reset)—— 清场时随旧系统一起删。
 *
 * 但**这一个函数是平台也要用的**(`platform-serve` / `platform-run` /
 * `platform smoke` 都靠它定位数据目录),所以单独留下来。它讲的是「数据在哪」,
 * 与旧 daemon 的生命周期无关。
 */
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * 数据目录。默认 `~/.sansheng`,可用 `SANSHENG_DATA` 覆盖。
 *
 * **每次调用都重新读 env** —— 不在模块加载期算死。旧实现踩过这个:
 * daemon / CLI 启动时 env 可能被改写,而模块加载期已经缓存了旧值。
 */
export function dataDir(): string {
  if (process.env.SANSHENG_DATA) return process.env.SANSHENG_DATA;
  return join(homedir(), ".sansheng");
}
