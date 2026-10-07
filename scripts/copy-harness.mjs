/**
 * 把仓库的 `harness/` 拷进 `dist/harness/`。
 *
 * ── 为什么需要它 ────────────────────────────────────────────────
 *
 * 「恢复出厂」要**写回出厂字节**,而不是删掉用户文件 —— 删文件会让提示词单元
 * 变成「未装载」态(agent 从此不知道那条规矩),那与「恢复默认」是两件事。
 *
 * 而出厂字节在运行时必须**可读**:源码树的 `harness/` 不会进 dist,所以构建时
 * 拷一份过去,运行时按 `dist/harness/system_prompts/` 定位。
 *
 * ── ⚠️ 目标目录必须**先删再拷**(2026-10-08,删掉两个提示词单元时发现)──────
 *
 * `cpSync` 是**覆盖式**的,它不删目标里「源已经没有了」的文件。所以
 * `worker.core.md` / `worker.protocol.md` 被删掉之后,**它们永远留在 dist 里** ——
 * 出厂副本从此带着两份仓库里不存在的单元:
 *
 *   · `platform smoke` / harness 页按**声明**读,所以界面上看不出(那条声明没了);
 *     但任何按**目录**枚举的读者(诊断、备份列表、人工排查)会看到 14 个之外的
 *     幽灵文件,并且**没有任何检查会红** —— 又一个「声明与实际不一致」的静默形态。
 *
 * ⇒ 先 `rmSync(dest)` 再拷。`dist/` 是构建产物,整目录删掉是安全的(它不由人编辑)。
 */
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "harness");
const dest = join(root, "dist", "harness");

if (!existsSync(src)) {
  console.error(`copy-harness: 源目录不存在 ${src}`);
  process.exit(1);
}
mkdirSync(join(root, "dist"), { recursive: true });
// 先删目标:见文件头「必须先删再拷」。
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });

// 自检:拷过去之后**单元个数必须相等**。一个「拷了一半」的构建产物看起来和
// 完整的一模一样(运行时只是多几条 missing),所以这里当场比。
const count = (dir) =>
  existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".md")).length : 0;
const nSrc = count(join(src, "system_prompts"));
const nDest = count(join(dest, "system_prompts"));
if (nSrc !== nDest) {
  console.error(
    `copy-harness: 单元个数不一致(源 ${nSrc} / 目标 ${nDest})—— ` +
      `出厂副本与仓库那一份必须逐个数相等,否则「恢复出厂」会写回一个不存在的字节`,
  );
  process.exit(1);
}
console.log(`copy-harness: ${src} → ${dest}(提示词单元 ${nDest} 个)`);
