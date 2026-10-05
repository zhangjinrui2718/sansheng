/**
 * 清理之后,用**读取侧的真代码**验一遍:四个角色各自装载了什么、缺了什么。
 * 判据来自 `ROLE_SPECS`(唯一真相),不是我自己列的文件名。
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { loadPromptUnits, composeSystemPrompt } from "../src/platform/runtime/promptAssembly.js";
import { PROJECT_ROLES, ROLE_SPECS } from "../src/platform/identity/role.js";

const dataDir = process.argv[2] ?? join(homedir(), ".sansheng");
let bad = 0;
for (const role of PROJECT_ROLES) {
  const ids = ROLE_SPECS[role].promptUnits as readonly string[];
  const r = loadPromptUnits(dataDir, ids);
  const mark = r.missing.length === 0 ? "✓" : "✗";
  if (r.missing.length > 0) bad += 1;
  console.log(`${mark} ${role.padEnd(18)} 声明 ${ids.length} 个 · 装载 ${r.loaded.length} 个 · 缺 ${r.missing.length} ${r.missing.length ? "→ " + r.missing.join(",") : ""}`);
}
const bm = composeSystemPrompt(dataDir, "business_manager");
console.log(`\n业务经理的系统提示:${bm.text.length} 字符`);
console.log(`  含「每个回合的正文都以一行工作记录开头」:${bm.text.includes("每个回合的正文都以一行工作记录开头")}`);
console.log(`  含 [未播报] 硬要求:${bm.text.includes("[未播报]")}`);
console.log(`  含「工件触发的回合甲方看不到」这类渠道规矩:${bm.text.includes("tell_client")}`);
process.exit(bad === 0 ? 0 : 1);
