/**
 * 语料检索 CLI 查看器(dev 工具) —— 「这个 wiki 里有什么」在没有前端读面时的可见口
 *
 * 用法:
 *   npx tsx .probe/knowledge-peek.mts <dataDir> <查询词...>
 *   例:`npx tsx .probe/knowledge-peek.mts ~/.sansheng 催收 全双工`
 *
 * 它做三件事,顺序与宿主启动时**完全一致**:
 *   ① 对该库跑一遍迁移(纯加法;028 会建 `knowledge_chunks` + FTS5 索引)
 *   ② `reindexAllKnowledge`(与 `platform-serve` 启动那次同一份实现、同一份装配)
 *   ③ 每个查询词打最多 3 条命中:来源坐标 + 出处 + 索引区间 + 现读状态 + 摘录
 *
 * ⚠️ 它会**写**这个库(迁移 + 语料行,幂等)。要在不影响正在跑的服务的前提下看,
 *    先把数据目录整份拷到临时目录再喂给它(`cp -R ~/.sansheng /tmp/x && … /tmp/x 催收`)。
 *
 * ⚠️ 检索是 **OR 语义 + 2 字 bigram**:「量化交易」会被切成 `量化 OR 化交 OR 交易`,
 *    于是「向量化 … 交易」这种文本也会命中 —— 精度是排序/AND 的事(P2),不是坏了。
 */
import { readFileSync } from "node:fs";
import { openPlatformDb } from "../src/platform/storage/index.js";
import { createGitWorkspace } from "../src/platform/workspace/git.js";
import { reindexAllKnowledge } from "../src/platform/knowledge/reindex.js";
import { buildMatchQuery, excerpt } from "../src/platform/knowledge/query.js";
import { searchKnowledgeChunks } from "../src/platform/storage/repo/knowledge.js";
import { makeArtifactTextReader, materializeChunk } from "../src/platform/knowledge/sources.js";
import { getArtifact } from "../src/platform/storage/repo/artifacts.js";

const dir = process.argv[2];
const queries = process.argv.slice(3);
if (dir === undefined || queries.length === 0) {
  console.error("用法:npx tsx .probe/knowledge-peek.mts <dataDir> <查询词...>");
  process.exit(2);
}

/** 工作根与会话 cwd 同一个来源:数据目录的 `settings.json` 的 `cwd`。 */
function workspaceRootOf(dataDir: string): string {
  try {
    const s = JSON.parse(readFileSync(`${dataDir}/settings.json`, "utf8")) as { cwd?: unknown };
    if (typeof s.cwd === "string" && s.cwd !== "") return s.cwd;
  } catch {
    // 读不到就用当前目录 —— 这与 boot 的缺省同源(它也是 `settings.cwd`)
  }
  return process.cwd();
}

const db = openPlatformDb(`${dir}/sansheng.db`);
let seq = 0;
const deps = {
  db,
  now: () => Date.now(),
  newId: (p: string) => `${p}_peek${++seq}`,
  workspace: createGitWorkspace(),
  workspaceRoot: workspaceRootOf(dir),
};

console.log(`数据目录 ${dir} · 工作根 ${deps.workspaceRoot}`);
for (const r of reindexAllKnowledge(deps)) {
  const extra = [
    r.pruned > 0 ? `清失效 ${r.pruned}` : "",
    r.unreadable.length > 0 ? `读不到 ${r.unreadable.length}` : "",
    r.pruneSkipped !== null ? "对账跳过" : "",
  ].filter((x) => x !== "").join(" · ");
  console.log(
    `[索引] ${r.projectId}: 工件 ${r.artifactsIndexed} · 消息 ${r.messagesIndexed} · 语料 ${r.chunks}` +
      (extra !== "" ? ` · ${extra}` : ""),
  );
}

const reader = makeArtifactTextReader(deps);
for (const q of queries) {
  const match = buildMatchQuery(q);
  console.log(`\n===== 查询「${q}」 ${match ?? "(切不出检索词:中文至少 2 字 / 英文至少 2 字符)"} =====`);
  if (match === null) continue;
  const hits = searchKnowledgeChunks(db, match, { limit: 3 });
  if (hits.length === 0) {
    console.log("0 命中(换一个词试试 —— 别把「没搜到」当成「项目里没有」)");
    continue;
  }
  for (const [i, h] of hits.entries()) {
    const c = h.chunk;
    const a = c.artifactId === null ? null : getArtifact(db, c.artifactId);
    const where =
      c.sourceKind === "artifact"
        ? `工件《${a?.title ?? "?"}》· ${a?.bodyPath ?? "?"}${a?.commitSha ? `@${a.commitSha.slice(0, 8)}` : ""}`
        : `消息 ${c.messageId}`;
    const m = materializeChunk(db, reader, c);
    console.log(
      `${i + 1}. [${c.sourceKind}] ${where} · 项目 ${c.projectId} · 块 ${c.id} · ` +
        `区间 [${c.offset}, ${c.offset + c.length}) · 状态 ${m.state}`,
    );
    if (m.state === "unavailable") console.log(`   ⚠️ 读不到:${m.problem}`);
    else console.log(`   ${excerpt(m.slice, 150)}`);
  }
}
db.close();
