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
 * 需要 LLM 行为的测试走显式注入(注入绕过闸门):
 *  - decide 单测:makeLlmCommunicatorDecide({ llmCall, getModel })(tests/agents/communicator-decide-llm.test.ts)
 *  - decide 集成:new AgentKernel(..., { decideLlmCall })(tests/server/task-single-path.test.ts T3/T4)
 *  - 沉淀单测:sedimentTurn({ llmCall, getModel }, ...)(tests/agents/sedimentation.test.ts)
 *  - 沉淀集成:new AgentKernel(..., { sedimentLlmCall })(tests/server/sedimentation-integration.test.ts)
 *
 * 生产不受影响:index.ts / cli 不设置这两个变量 → 闸门默认开,有模型即走 LLM。
 */
process.env.SANSHENG_DECIDE_LLM = process.env.SANSHENG_DECIDE_LLM ?? "0";
process.env.SANSHENG_SEDIMENT = process.env.SANSHENG_SEDIMENT ?? "0";

