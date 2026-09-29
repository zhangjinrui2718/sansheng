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
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 60_000;

export async function embedText(text: string, provider: EmbeddingProvider): Promise<number[] | null> {
  if (!text || text.length < 3) return null;

  // 缓存命中
  const cached = cache.get(text);
  if (cached && Date.now() - cached.ts < CACHE_TTL_MS) {
    return cached.embedding;
  }

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
    cache.set(text, { embedding: emb, ts: Date.now() });
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