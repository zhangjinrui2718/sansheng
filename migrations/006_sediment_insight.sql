-- 批次 7-J · 沉淀工件 kind 归位(hypothesis/intent/decision → insight)
--
-- 背景(一次真实事故的诊断结论,会话 conv_murnhpls_oha6,2026-10-03):
--   沉淀服务(sedimentation)从对话里提炼认知时,复用了**工作流 kind**
--   hypothesis / intent / decision / note。而这些 kind 在协议侧已有确定含义:
--     hypothesis = executor 阻塞信号,带 callbackReason + 父 todo 转
--                  waiting_for_decision + 发 executor_callback → **有流程会处理**;
--     decision   = 用户/沟通员已确认的决定 → 具约束力;
--     intent     = 触发 Planner 的目标。
--   沉淀产出的那些(status=open、无 callbackReason、无父 todo、无 bus 事件)
--   **没有任何 agent 会消费** —— 全库没有任何代码按 kind 扫 hypothesis,
--   升级流程由 executor_callback 事件 + 父 todo 状态驱动。
--   两者在 UI 上是同一种卡片,语义却完全相反。
--
-- 本迁移把**存量**沉淀工件改判为 `insight`,并把 D7 四形态的认知状态
-- 搬进 `metadata.sedimentForm`(goal / decision / hypothesis / fact)。
-- 工作流 kind 归还协议专用。
--
-- 幂等性:WHERE 命中 `metadata.source='sedimentation'` 的工件,而这些工件迁移后
-- kind 变成 insight、source 仍是 sedimentation —— **再跑一次仍会命中**。
-- 所以幂等性必须靠 sedimentForm 的取值逻辑,不能靠「WHERE 不再命中」:
--   COALESCE(CASE kind WHEN <四个旧 kind> THEN <对应 form> END,
--            既有 metadata.sedimentForm)
-- 第二遍时 kind 已是 insight(不匹配四个旧值)CASE 返回 NULL,于是回退到**已有**的
-- sedimentForm 保持不变。
-- ⚠️ 曾经写成裸 CASE 而没有 COALESCE:第二遍会把 sedimentForm 覆写成 NULL ——
-- tests/storage/migration-006.test.ts 的「跑两遍相同」用例抓到过。
--
-- 只动 blackboards.artifacts_json 里的元素,不改表结构、不删数据。
-- 非沉淀工件(无 metadata.source 或 source≠sedimentation)一律原样保留:
-- 最后那层 CASE 的 ELSE 分支把它原封不动地写回。

UPDATE blackboards
SET artifacts_json = (
  SELECT json_group_array(
    CASE
      WHEN json_extract(value, '$.metadata.source') = 'sedimentation' THEN json(json_set(
        value,
        '$.kind', 'insight',
        '$.metadata.sedimentForm',
        COALESCE(
          CASE json_extract(value, '$.kind')
            WHEN 'intent'      THEN 'goal'
            WHEN 'decision'    THEN 'decision'
            WHEN 'hypothesis'  THEN 'hypothesis'
            WHEN 'note'        THEN 'fact'
          END,
          json_extract(value, '$.metadata.sedimentForm')
        )
      ))
      ELSE json(value)
    END
  )
  FROM json_each(blackboards.artifacts_json)
)
WHERE EXISTS (
  SELECT 1 FROM json_each(blackboards.artifacts_json)
  WHERE json_extract(value, '$.metadata.source') = 'sedimentation'
);
