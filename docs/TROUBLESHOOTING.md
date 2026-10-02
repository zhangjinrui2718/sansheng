# Sansheng 故障排查手册

> 面向「跑了一个案例,结果不对 / 失败了 / 行为怪」的排查场景。
> 2026-10-02 批次 7 排查三个用户反馈时整理,配套 `npm run diagnose`。
> **只读操作** —— 本文档与诊断脚本都不会改数据。

---

## 0. 先跑这个

```bash
npm run diagnose              # 概览:所有会话 + 失败根因候选,一步到位
npm run diagnose <convId>     # 单会话全量诊断(含失败现场的原始 LLM 输出)
npm run diagnose --harness    # 只看 harness 提示词体检
```

脚本是只读的(`better-sqlite3` readonly 模式),可以在服务运行时安全执行。
数据目录解析顺序与 `src/cli/commands.ts` 的 `dataDir()` 一致:
`$SANSHENG_DATA` > `~/.sansheng`。排查别的实例:`SANSHENG_DATA=/tmp/x npm run diagnose`。

---

## 1. 数据在哪

```
~/.sansheng/
├── sansheng.db            ← 主库(WAL 模式)
├── sansheng.db-wal        ← 可能几百 MB,正常,不影响读取
├── sansheng.db-shm
├── settings.json          ← provider / modelId / apiKey(密文)/ cwd
├── .keyring               ← keyring 加密密钥,别删
├── logs/sansheng.log      ← ⚠ 长期为 0 字节,见 §2
├── harness/system_prompts/  ← 各 agent 的 system prompt(**可编辑**,见 §5)
│   ├── communicator.md  planner.md  executor.md  critic.md  memory.md  reflection.md
├── sessions/<convId>/bus.jsonl  ← MessageBus 事件流
├── pi/                    ← Pi SDK 的 agentDir(基本空)
└── harness/, .keyring …
```

### 表结构(实测,别凭 schema 文件想象)

| 表 | 内容 | 排查时的价值 |
| --- | --- | --- |
| `conversations` | 会话元数据(title / model / cwd / token 统计) | 找会话 id |
| `messages` | 真实对话消息 | 看用户说了什么、沟通员答了什么 |
| `blackboards` | **legacy 快照 + artifacts_json** | ⚠ 见下,最关键 |
| `fragments` / `user_profile` | 长期记忆 / 用户画像 | 查记忆注入 |
| `agent_states` | agent 状态 | 一般用不上 |
| `fragments_vec*` | sqlite-vec 索引 | 用不上 |

### ⚠ 三个最容易踩的坑

**坑 1:没有独立的 artifacts 表。**
M3+ 之后所有 `BlackboardArtifact`(intent / todo / evidence / hypothesis / note)
都以 **JSON 数组存在 `blackboards.artifacts_json` 这一列**里。
一个 conversation 可能有多行 blackboard(每轮 run 一行),**要全部合并去重**。
拿 sqlite3 直接查:

```bash
sqlite3 ~/.sansheng/sansheng.db \
  "SELECT artifacts_json FROM blackboards WHERE conversation_id='<convId>';"
```

**坑 2:`blackboards` 的 `goal` / `plan_json` / `todos_json` 是 M3b 遗留列。**
在 artifact 体系下它们**长期为空**。看到 `goal=''` 千万别得出「plan 没跑」的结论 ——
真实运行状态全在 `artifacts_json` 里。
(2026-10-02 排查时就差点被这个空列带偏。)

**坑 3:`bus.jsonl` 的 `direction` 字段有误导性。**
它形如 `"comm→user"`,但**真实收件人看 `toRole`**。例如实际是发给 planner 的:

```json
{"direction":"comm→user","toRole":"planner","context":{"source":"decide_task"}}
```

`context.source` 反而是好用的判别位:`decide_chat` / `decide_task` / `decide_clarify` /
`decide_feedback`。

---

## 2. 日志:基本别指望它

`~/.sansheng/logs/sansheng.log` **一直是 0 字节** —— 日志走 `src/shared/log.ts`
打到 **stdout**,没落文件。服务以 `sansheng start` 启动时输出在启动它的终端里。

所以排查时:

- **别去找历史日志文件**,没有。
- 要看日志就重启服务并盯着 stdout:`sansheng start 2>&1 | tee /tmp/sansheng.log`。
- 长期取证靠的是 **DB 里的 artifacts**(见 §3),不是日志。

---

## 3. 排查主流程(照着走)

### 第 1 步:确认「哪一步」断了

`npm run diagnose` 概览会直接标出**第一个非级联的失败 todo**。
级联失败(`errorReason` 以 `cascade from` 开头)**不是根因**,是被上游带走的。
2026-10-02 那个案例:表面 5 个 failed,真根因只有 `todo-2` 一个,另外 3 个是级联,
还有 1 个是 intent 自身终态。

### 第 2 步:翻出失败现场

Executor / Planner 解析 LLM 输出失败时,会写一条 `exec-err-*` / note artifact,
**它的 body 里存着失败那一刻的原始 LLM 输出**(前 500 字符)。
这是整个系统里最有取证价值的东西 —— 它能直接告诉你模型写了什么、为什么没被接受。

```bash
npm run diagnose <convId>    # 脚本会自动打印这段,不截断
```

手工取:

```bash
sqlite3 ~/.sansheng/sansheng.db \
  "SELECT artifacts_json FROM blackboards WHERE conversation_id='<convId>';" \
| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
  for(const a of JSON.parse(s)) if(a.id?.startsWith("exec-err")) console.log(a.body);
})'
```

### 第 3 步:对照决策链判断是哪一环的锅

```
用户消息
  → messages(role=user)              有吗?
  → decide(communicator)             bus.jsonl 有 decide_chat/task/clarify 吗?
  → onTask → runPlan                 planner.md 内容被 planner 收到吗?(§5)
  → Planner → todos                  intent + todo-* artifacts 落库了吗?
  → Executor(每个 todo)              todo 的 status + 关联的 evidence / note
```

逐环对照,断在哪环就是哪环的 bug。脚本输出的三段正好对应:
消息段 → decide 段(bus)→ artifacts 段。

### 第 4 步:用 `usage=0` 判断消息来源

`messages` 里 assistant 消息 `usage_input/output = 0`,说明**它不是 Pi session 直答**,
而是 kernel 合成的**交接确认 / clarify 提问**。这是批次 5b-1 之后 task / feedback /
clarify 三条路径的正常形态(§B2 根治双回复后,这些路径不走 Pi turn)。
**看到 usage=0 不要以为「没跑 LLM」** —— decide LLM 确实跑了,只是不记 usage。

---

## 4. 症状 → 病因速查

| 症状 | 先查 | 常见病因 |
| --- | --- | --- |
| 整轮 plan 判失败,但有部分 todo 是 `resolved` | `exec-err-*` note 的 body | LLM 输出被 maxTokens 截断 → 解析失败 → 级联带走下游 |
| todos 全是 `failed` 且 `errorReason` 是 `cascade from` | 上游第一个真失败 | 上游一失败下游全灭,**看上游别看下游** |
| 某 todo 的 evidence 带 `[truncated]` | 该 evidence 的 body | 输出超预算被截断救回,**内容不完整**,下游综合要当心 |
| plan 根本没起来(artifacts 为空) | bus.jsonl 有没有 `decide_task` | decide 没判 task / `onTask` 没接上 / `runPlan` 早退(无 apiKey、plan_busy) |
| 沟通员答非所问、张口就委派 | decide 的 kind 分布 | 需求该 clarify 却判了 task(7-C 已加 clarify) |
| 分发任务粗暴、没有拆解 | `npm run diagnose --harness` | planner 提示词是 stub / 没真正到达模型(§5) |
| 用户消息里出现 `# Relevant Memories` blob | messages.content | raw/enriched 未分离(5a.5 T1 已修,见到的是历史脏数据) |
| 记忆里的内容是垃圾/重复 | `fragments` 表 | 沉淀管道问题,不是对话问题 |

---

## 5. harness 提示词:改之前先确认它生效

`~/.sansheng/harness/system_prompts/*.md` 是**用户可编辑**的 agent 人设/规约。
`ensureHarness()` 首次启动时写出出厂默认,之后只在「文件内容恰好等于某个历史出厂
默认」时自动升级(用户编辑过的一律保留不覆盖)。

### ⚠ 批次 7-B 的血泪:提示词可能根本没送到模型

7-B 之前,`planner.md` / `executor.md` 是**死接线**:

- `Orchestrator` 存了 `this.dataDir` 却从没用过,`spawnPlanner` 只传 `{ storage }`;
- Planner 落到模块内 `DEFAULT_PLANNER_PROMPT`(仅 167 字符的 stub);
- `shared/prompts/planner.md` 那份 91 行正经提示词是**死代码**(`loadPlannerPrompt` 无调用方)。

即:用户在 harness 里怎么改都没用。**「改了提示词没效果」先怀疑这条线。**

现在已接线(`Orchestrator` 构造时经 `loadHarness(dataDir)` 解析并注入)。
守护测试:`tests/agents/orchestrator-harness-prompt.test.ts`
—— **新增/修改提示词接线时必须让它继续绿。**

体检:

```bash
npm run diagnose --harness
```

经验阈值:**字符数 < 400 的提示词基本等于没写内容**,脚本会标红。

`communicator` 侧一直是对的(agentKernel 走 `loadHarness`),只有 planner/executor
踩过这个坑。

---

## 6. 造一个可控的复现场景

别拿真实数据试手。vitest 里的现成 harness(都在走**生产代码**,只 fake SDK 边界):

| 需求 | 参考文件 |
| --- | --- |
| decide=task 只走 runPlan,不双回复 | `tests/server/task-single-path.test.ts` |
| clarify 不委派、不走 Pi 直答 | `tests/server/clarify-single-path.test.ts` |
| 截断输出救回 | `tests/agents/executor-truncation.test.ts` |
| planner/executor 提示词确实到达 | `tests/agents/orchestrator-harness-prompt.test.ts` |
| 截断 JSON 修复算法本身 | `tests/shared/jsonRepair.test.ts` |
| 完整 runPlan + Orchestrator + WS 集成 | `tests/server/ws-plan-integration.test.ts` |

harness 套路:临时目录 + `Storage`/`SettingsStore`/`Keyring` 真实例,
只 fake `@earendil-works/pi-coding-agent` 的 `createAgentSession`
(用来捕获 `session.prompt` 全文 —— **双执行的探针**),
LLM 调用走 `attachWebSocket` 的 `llmCallFactory` / kernel 的 `decideLlmCall` seam。

### 改提示词 / 改解析逻辑后的自检

```bash
npm run typecheck && npm test && npm run build
grep -rn 'as any' src/ | wc -l    # 必须为 0
```

改 `src/server/**` 后记得 `npm run build` —— 全局命令
`/opt/homebrew/bin/sansheng` 是**软链到仓库的 `dist/`**,不 build 就还是旧逻辑。
