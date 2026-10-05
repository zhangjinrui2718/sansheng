/**
 * 清理 `~/.sansheng/harness/system_prompts/` 里的**旧角色名残留文件**(一次性)
 *
 * 判据不是「名字看着旧」,而是**与代码里的声明集合做差集**:
 * `promptUnitIds()` 由 `ROLE_SPECS[].promptUnits` 推导(唯一真相),
 * 目录里不在那个集合里的 `.md` 就是「没人读的文件」。
 *
 * 用法:`npx tsx .probe/w3-legacy-prompts.mts <dataDir> [--move]`
 * 不带 `--move` 只打印两侧清单(**先看后删**)。
 */
import { readdirSync, existsSync, mkdirSync, renameSync } from "node:fs";
import { join } from "node:path";
import { promptUnitIds } from "../src/platform/harness/write.js";

const [dataDir, flag] = process.argv.slice(2);
if (dataDir === undefined) { console.error("用法:… <dataDir> [--move]"); process.exit(2); }
const dir = join(dataDir, "harness", "system_prompts");
if (!existsSync(dir)) { console.error(`目录不存在:${dir}`); process.exit(2); }

const declared = new Set(promptUnitIds());
const files = readdirSync(dir).filter((f) => f.endsWith(".md"));
const kept = files.filter((f) => declared.has(f.replace(/\.md$/, ""))).sort();
const legacy = files.filter((f) => !declared.has(f.replace(/\.md$/, ""))).sort();
// 反向:声明了但盘上没有(那才是真问题 —— 模型会缺规矩)
const missing = [...declared].filter((u) => !files.includes(`${u}.md`)).sort();

console.log(`目录:${dir}`);
console.log(`文件 ${files.length} 个 | 被声明的单元 ${declared.size} 个`);
console.log(`\n【留下】命中声明的 ${kept.length} 个:\n  ${kept.join("\n  ")}`);
console.log(`\n【待清】不在声明集合里的 ${legacy.length} 个:\n  ${legacy.join("\n  ")}`);
console.log(`\n【⚠️ 声明了但盘上没有(必须为空)】${missing.length} 个: ${missing.join(", ") || "(空 ✓)"}`);
if (missing.length > 0) { console.error("有缺失单元 —— 先解决它,不要动目录"); process.exit(1); }
if (flag !== "--move") { console.log("\n(只看了没动。加 --move 才搬走)"); process.exit(0); }

const at = new Date().toISOString().replace(/[:.]/g, "-");
const quarantine = join(dataDir, "harness", "backups", `legacy-prompt-units-${at}`);
mkdirSync(quarantine, { recursive: true });
for (const f of legacy) {
  renameSync(join(dir, f), join(quarantine, f));
  console.log(`  搬走 ${f} → ${quarantine}`);
}
console.log(`\n隔离目录:${quarantine}`);
console.log(`搬走 ${legacy.length} 个;目录里现在剩 ${readdirSync(dir).filter((f) => f.endsWith(".md")).length} 个 .md`);
