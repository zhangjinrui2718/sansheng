/**
 * 把 `scripts/model-catalog-overrides.json` 里的 model 合并进 pi-ai 的内置 catalog。
 *
 * ── 为什么需要它 ──────────────────────────────────────────────────────
 *
 * 平台侧的 `resolveModel()` 只查 pi-ai 的内置 catalog:
 *
 *   src/platform/infra/providers.ts:169
 *     const builtin = getBuiltinModel(provider, modelId);
 *     if (!builtin) { log.warn(`resolveModel: unknown model ...`); return null; }
 *
 * 而 `getBuiltinModel` 是**纯静态查表**(pi-ai `providers/all.js:49`
 * `MODELS[provider]?.[modelId]`),不读任何用户文件 ⇒ 上游 catalog 里没有的 model,
 * 三生既跑不起来、设置界面也列不出来(`listProviders` 走的是同一个 `MODELS`)。
 *
 * pi-coding-agent 那边其实有用户层(`<agentDir>/models.json`),但**三生够不着**:
 * `resolveModel` 在把 model 对象交给 `createAgentSession` **之前**就已经拒了。
 *
 * ── 为什么是「改 node_modules + postinstall」而不是改 `providers.ts` ────
 *
 * · 改 node_modules:一处数据、零处源码。`resolveModel` 与 `listProviders`
 *   同时生效 —— 因为它们读的是**同一个** catalog。
 * · 改 `providers.ts`:那是给「任意用户都能加 model」做的结构性功能,得开批次、
 *   配回归测试、想清楚覆盖文件放哪、要不要跟着 settings 走。
 *   ⚠️ 那是**另一个决定**,不该由「我想加一个 model」顺带做掉。
 *   真要做,正确形态是让 `resolveModel` 读 `<dataDir>` 下的用户覆盖层 ——
 *   那同时能把「数据目录里那份配置没人读」这个悬案一起收掉。
 *
 * 代价:这是 monkey-patch。`npm install` 会冲掉它,所以挂 `postinstall` 重放。
 * `patch-package` 能做同一件事,但它的产物是对**单行压缩 JSON** 的 diff ——
 * 人读不懂、review 不了。这里换成一个能读的脚本,代价是一次性多一个 postinstall。
 *
 * ── 三条纪律 ─────────────────────────────────────────────────────────
 *
 * 1. **幂等**:已经在 catalog 里且逐字相同 ⇒ 不写盘、不动 mtime。
 * 2. **绝不因失败而让 `npm install` 挂掉**:找不到 pi-ai / JSON 坏了 ⇒ 如实打印
 *    警告并以 0 退出。装包失败是**大事**,少一个 model 只是回到内置行为。
 * 3. **写回保持压缩单行**:用 `JSON.stringify` 不带缩进,让 diff 只有那一行。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const overridesPath = join(root, "scripts", "model-catalog-overrides.json");
const dataDir = join(
  root,
  "node_modules",
  "@earendil-works",
  "pi-ai",
  "dist",
  "providers",
  "data",
);

function warn(msg) {
  process.stderr.write(`[patch-model-catalog] ${msg}\n`);
}

if (!existsSync(dataDir)) {
  warn(`跳过:找不到 pi-ai catalog 目录 ${dataDir}(依赖还没装?)`);
  process.exit(0);
}
if (!existsSync(overridesPath)) {
  warn(`跳过:找不到 ${overridesPath}`);
  process.exit(0);
}

/** 读覆盖文件。`$comment` 之类的元数据键不是 provider,剔掉。 */
let overrides;
try {
  const parsed = JSON.parse(readFileSync(overridesPath, "utf8"));
  overrides = Object.fromEntries(
    Object.entries(parsed).filter(([k]) => !k.startsWith("$")),
  );
} catch (err) {
  warn(`跳过:覆盖文件解析失败 —— ${err instanceof Error ? err.message : String(err)}`);
  process.exit(0);
}

let added = 0;
let replaced = 0;
let unchanged = 0;

for (const [provider, byApi] of Object.entries(overrides)) {
  const file = join(dataDir, `${provider}.json`);
  if (!existsSync(file)) {
    warn(`跳过 ${provider}:pi-ai 里没有 ${provider}.json(上游改名了?)`);
    continue;
  }

  let catalog;
  try {
    catalog = JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    warn(`跳过 ${provider}:catalog 解析失败 —— ${err instanceof Error ? err.message : String(err)}`);
    continue;
  }

  for (const [api, models] of Object.entries(byApi)) {
    const bucket = (catalog[api] ??= {});
    for (const [key, model] of Object.entries(models)) {
      const existed = Object.hasOwn(bucket, key);
      const same = existed && JSON.stringify(bucket[key]) === JSON.stringify(model);
      if (same) {
        unchanged++;
        continue;
      }
      if (existed) replaced++;
      else added++;
      bucket[key] = model;
    }
  }

  try {
    writeFileSync(file, JSON.stringify(catalog));
  } catch (err) {
    warn(`${provider}:写回失败 —— ${err instanceof Error ? err.message : String(err)}`);
  }
}

process.stdout.write(
  `[patch-model-catalog] 新增 ${added} · 覆盖 ${replaced} · 已一致 ${unchanged}\n`,
);
