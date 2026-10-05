/**
 * W3-③ · **一次 reset**:把出厂提示词写回数据目录
 *
 * ── 为什么需要它(实机证据,不是猜测)────────────────────────────
 *
 * 运行期读的是 `<dataDir>/harness/system_prompts/{unitId}.md`,而**出厂副本**
 * (`dist/harness/system_prompts/`,构建时由 `scripts/copy-harness.mjs` 拷出)只有在
 * **显式恢复出厂**时才会落到数据目录。⇒ **仓库里改了提示词 ≠ 运行期生效**。
 *
 * 2026-10-05 实测:`~/.sansheng/` 里 4 个单元停留在 W2 之前 —— 最要紧的
 * `business_manager.core.md` 只有 39 行(出厂 215 行),**没有**「正文是工作记录 /
 * 工件触发的回合不进甲方通道 / `[未播报]` 必须写在第一行」这三条规矩。
 * 真回合因此拿不到新判据(arm A 的现场见 `.probe/w3-e2e-turn1-stale-prompts.txt`)。
 *
 * ── 它调的就是 HTTP 那个端点调的函数 ───────────────────────────
 *
 * `app.post("/api/harness/units/:unitId/reset")` → `resetPromptUnit(deps.harnessDirs, …)`。
 * 这里直接调同一个函数(不起服务、不碰数据库),`dirs.factoryDir` 与
 * `host/serve.ts` 接线时用的那一个同值:`<dist>/harness/system_prompts`。
 *
 * ── 可逆性(为什么这个操作是安全的)────────────────────────────
 *
 * `resetPromptUnit` → `writePromptUnit` 的顺序是「校验 id → **备份** → 原子写 → 回读」,
 * 所以每个被覆盖的文件在 `<dataDir>/harness/backups/prompts/` 里都有一份 `.bak`。
 * 本脚本把备份路径原样打出来。
 *
 * 用法:`npx tsx .probe/w3-reset-prompts.mts <dataDir> [factoryDir]`
 */
import { join, resolve } from "node:path";
import { promptUnitIds, resetPromptUnit } from "../src/platform/harness/write.js";

const [dataDir, factoryArg] = process.argv.slice(2);
if (dataDir === undefined) {
  console.error("用法:npx tsx .probe/w3-reset-prompts.mts <dataDir> [factoryDir]");
  process.exit(2);
}
const factoryDir = factoryArg ?? resolve(process.cwd(), "dist/harness/system_prompts");

console.log(`[reset] dataDir    = ${dataDir}`);
console.log(`[reset] factoryDir = ${factoryDir}`);

const ids = promptUnitIds();
console.log(`[reset] 单元数 = ${ids.length}(${ids.join(", ")})`);

let failed = 0;
for (const id of ids) {
  const r = resetPromptUnit({ dataDir, factoryDir }, id, Date.now());
  if (!r.ok) {
    failed += 1;
    console.log(`  ✗ ${id}: ${r.reason} —— ${r.detail ?? ""}`);
    continue;
  }
  const backup = r.backupPath !== undefined ? `备份 ${r.backupPath}` : "无备份(该单元此前不存在)";
  console.log(`  ✓ ${id}: 回读 ${r.content?.length ?? 0} 字符 · ${backup}`);
}

if (failed > 0) {
  console.error(`[reset] ✗ ${failed} 个单元恢复失败 —— 不静默通过`);
  process.exit(1);
}
console.log(`[reset] ✓ ${ids.length} 个单元全部按出厂字节写回`);
