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
 */
import { cpSync, existsSync, mkdirSync } from "node:fs";
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
cpSync(src, dest, { recursive: true });
console.log(`copy-harness: ${src} → ${dest}`);
