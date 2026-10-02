import { log } from "../../shared/log.js";

export interface EmbeddingProvider {
  baseUrl: string;
  apiKey: string;
  model: string;
}

interface CacheEntry {
  embedding: number[];
  ts: number;
}

/**
 * C4(审查 §C4「cache Map 无界」):缓存条目上限。
 * 选型论证 —— LRU(size cap + 最近使用序)而非纯 size cap 无序淘汰:
 *  - 每条 entry 是 1536 维 double 数组(≈12KB 裸数据,JS Array 开销后更多),
 *    旧实现只在读取时判 60s TTL、**从不删除条目** → 常驻进程内存随 embed 过的
 *    文本数线性增长,永不释放;
 *  - 该缓存的真实用途是「短窗口内重复文本去重」(TTL 60s,同内容 fragment
 *    多次入库/检索富集),访问天然有时间局部性 → LRU 命中率严格优于随机/ FIFO
 *    无序淘汰,且 Map 插入序实现只要 ~10 行、零新依赖;
 *  - 上限 200 条 ≈ 200×1536×8B ≈ 2.5MB 裸数据(含对象开销数 MB),对单用户
 *    本地服务是合理的常驻上界;TTL 语义保留(过期条目读时删除)。
 */
export const EMBEDDING_CACHE_MAX_ENTRIES = 200;
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

/** 读缓存:TTL 过期即删;命中则移到 LRU 尾部(delete+set = 标记最近使用)。 */
function cacheRead(text: string): number[] | null {
  const cached = cache.get(text);
  if (!cached) return null;
  if (Date.now() - cached.ts >= CACHE_TTL_MS) {
    cache.delete(text);
    return null;
  }
  cache.delete(text);
  cache.set(text, cached);
  return cached.embedding;
}

/** 写缓存:超上限时按插入序淘汰最旧条目(Map 迭代序 = LRU 序)。 */
function cacheWrite(text: string, embedding: number[]): void {
  if (cache.has(text)) cache.delete(text);
  cache.set(text, { embedding, ts: Date.now() });
  while (cache.size > EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

export async function embedText(text: string, provider: EmbeddingProvider): Promise<number[] | null> {
  if (!text || text.length < 3) return null;

  // 缓存命中
  const hit = cacheRead(text);
  if (hit) return hit;

  const url = joinUrl(provider.baseUrl, "/v1/embeddings");
  if (!url) {
    // baseUrl 缺失或不合法——避免走 fetch 报 “Failed to parse URL”。
    // fragment 不写入向量(下次 searchFragments 会降级到 LIKE)即可。
    log.muted(`embedding: skipped, no baseUrl (provider="${provider.model}")`);
    return null;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);

  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(provider.apiKey ? { authorization: `Bearer ${provider.apiKey}` } : {}),
      },
      body: JSON.stringify({ input: text.slice(0, 4000), model: provider.model }),
      signal: controller.signal,
    });
    if (!r.ok) {
      log.warn(`embedding: HTTP ${r.status} from ${url}`);
      return null;
    }
    const data = (await r.json()) as { data?: Array<{ embedding?: number[] }> };
    const emb = data.data?.[0]?.embedding;
    if (!Array.isArray(emb)) return null;
    cacheWrite(text, emb); // C4:经 LRU 写入(超上限淘汰最旧)
    return emb;
  } catch (err) {
    log.warn(`embedding: failed for "${text.slice(0, 30)}...":`, err instanceof Error ? err.message : err);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function joinUrl(base: string, path: string): string {
  // base 可能未配(在 M1.5 引入的可选项)。如果为空或不合法,
  // 不能退回相对路径——fetch 会报 "Failed to parse URL"。
  // 调用方会检查返回值是否合法(空字符串)决定 fallback 还是 warn+null。
  if (!base || !base.match(/^https?:\/\//)) {
    return "";
  }
  return base.replace(/\/+$/, "") + path;
}