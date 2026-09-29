-- 1536 维(OpenAI text-embedding-3-small 默认)
-- 如果 sqlite-vec 没加载,这个 migration 应该被跳过(fragments repo 检测后决定 search 路径)
CREATE VIRTUAL TABLE IF NOT EXISTS fragments_vec USING vec0(
  fragment_id TEXT PRIMARY KEY,
  embedding FLOAT[1536]
);