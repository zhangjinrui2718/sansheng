/**
 * vitest 全局 setup(批次 5b-1 P1;批次 5b-2 T1 追加沉淀闸门)。
 *
 * SANSHENG_DECIDE_LLM=0 —— 默认关闭沟通员 decide 的真实 completeSimple 网络路径:
 * 集成测试普遍用 fake apiKey + resolved model(getModel() 非 null),不关的话每条
 * WS 消息都会发起一次真实 HTTP 分类请求(触网、慢、CI 抖动源)。
 *
 * SANSHENG_SEDIMENT=0 —— 批次 5b-2 T1 同款卫生闸门:不关的话每个 chat 回合的
 * message_end 都会触发一次真实沉淀 LLM 调用(37 个测试文件的集成测试全中招)。
 *
 * SANSHENG_ALIGN=0 —— 批次 7-E 同款卫生闸门:不关的话每条 task 消息在开工前都会
 * 发起一次真实 HTTP 对齐请求(触网、慢、CI 抖动源)。需要验证「拦下来问用户」的
 * 测试走显式注入(注入绕过闸门):new AgentKernel(..., { alignLlmCall })。
 *
 * 需要 LLM 行为的测试走显式注入(注入绕过闸门):
 *  - decide 单测:makeLlmCommunicatorDecide({ llmCall, getModel })(tests/agents/communicator-decide-llm.test.ts)
 *  - decide 集成:new AgentKernel(..., { decideLlmCall })(tests/server/task-single-path.test.ts T3/T4)
 *  - 沉淀单测:sedimentTurn({ llmCall, getModel }, ...)(tests/agents/sedimentation.test.ts)
 *  - 沉淀集成:new AgentKernel(..., { sedimentLlmCall })(tests/server/sedimentation-integration.test.ts)
 *  - 对齐集成:new AgentKernel(..., { alignLlmCall })(tests/server/align-gate.test.ts)
 *  - 判断轮集成:new AgentKernel(..., { workerAskLlmCall })(tests/server/worker-ask.test.ts)
 *
 * SANSHENG_WORKER_ASK=0 —— 批次 7-L 同款卫生闸门:不关的话每次执行者卡住都会
 * 发起一次真实 HTTP 判断轮请求(触网、慢、CI 抖动源)。关掉后判断轮返回 null =
 * 退回「照旧升级用户」,即 7-L 之前的行为;要验证「沟通员自己答」那条新路径的
 * 测试走显式注入(注入绕过闸门):new AgentKernel(..., { workerAskLlmCall })。
 *
 * 生产不受影响:index.ts / cli 不设置这几个变量 → 闸门默认开,有模型即走 LLM。
 */
process.env.SANSHENG_DECIDE_LLM = process.env.SANSHENG_DECIDE_LLM ?? "0";
process.env.SANSHENG_SEDIMENT = process.env.SANSHENG_SEDIMENT ?? "0";
process.env.SANSHENG_ALIGN = process.env.SANSHENG_ALIGN ?? "0";
process.env.SANSHENG_WORKER_ASK = process.env.SANSHENG_WORKER_ASK ?? "0";


// 批次 6 收尾(主会话):真实家目录里不应被测试建出空目录 —— 「用真 HOME 且无
// settings.json」的既有测试首次 load 会触发默认工作目录自动创建。默认关掉建目录,
// 需要验证该行为的测试文件显式置 "0"(与 DECIDE_LLM/SEDIMENT 闸门同款形态)。
process.env.SANSHENG_SKIP_WORKSPACE_MKDIR =
  process.env.SANSHENG_SKIP_WORKSPACE_MKDIR ?? "1";
