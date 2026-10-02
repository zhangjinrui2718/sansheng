/**
 * vitest 全局 setup(批次 5b-1 P1)。
 *
 * SANSHENG_DECIDE_LLM=0 —— 默认关闭沟通员 decide 的真实 completeSimple 网络路径:
 * 集成测试普遍用 fake apiKey + resolved model(getModel() 非 null),不关的话每条
 * WS 消息都会发起一次真实 HTTP 分类请求(触网、慢、CI 抖动源)。
 *
 * 需要 LLM decide 行为的测试走显式注入(注入绕过闸门):
 *  - 单测:makeLlmCommunicatorDecide({ llmCall, getModel })(tests/agents/communicator-decide-llm.test.ts)
 *  - 集成:new AgentKernel(..., { decideLlmCall })(tests/server/task-single-path.test.ts T3/T4)
 *
 * 生产不受影响:index.ts / cli 不设置该变量 → 闸门默认开,有模型即走 LLM 分类。
 */
process.env.SANSHENG_DECIDE_LLM = process.env.SANSHENG_DECIDE_LLM ?? "0";
