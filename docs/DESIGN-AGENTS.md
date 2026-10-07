# 设计 2 · 角色 Agent 与 Harness 配置

**状态**:草案 · 2026-10-03
**前置**:设计 1《工程平台设计》—— 本文的 `Capability` / `Scope` / `RoleSpec` 概念全部来自那里,不在此重复定义。

---

## 0. 角色总表

| 角色 | 代号 | 人数 | 客户可见 | 核心产出 |
|---|---|---|---|---|
| 业务经理 | `business_manager` | 1 | ✅ | 立项书、需求基线、对甲方的全部沟通 |
| 项目经理 | `project_manager` | 1 | ❌ | 工作分解树、排期与依赖、进度汇总 |
| 研究工 | `research_worker` | 多个 | ❌ | **信息**:技术方案、架构图、调研结论、汇报材料(HTML 报告) |
| 编码工 | `coding_worker` | 多个 | ❌ | **能跑的东西**:可独立部署到 Docker 的代码服务(git 仓库) |
| 质检审查员 | `quality_reviewer` | 1 | ❌ | 审查意见、符合性判定 |

**与现状的映射**:

| 旧代号 | 新角色 | 状态 |
|---|---|---|
| `communicator` | `business_manager` | 已验证可用(7-L 升级链扎实) |
| `planner` | `project_manager` | 已验证可用 |
| `executor` | `research_worker` + `coding_worker` | 已验证可用;2026-10-08 按产出形态一分为二(见 §4 / §5) |
| `critic` | `quality_reviewer` | **零实现**,本次全新建设 |
| `memory` / `reflection` / `harness_manager` | — | **删除**。见 §7 |

> **角色集已按 2026-10-03 决策定稿**:取消 `tech_lead`。项目初期不设「领域负责人 + 执行者」的二层结构,**做具体工作的职责直接放在执行角色上**(可多个,分工程/算法/数据)。
>
> **2026-10-08 的修订**:执行角色由**一个**变成**两个**(研究工 / 编码工),划分轴是
> **产出形态**而不是层级。它们平级,升级目标都是项目经理。见 §4 / §5。

---

## 1. 组织规则:唯一真正重要的部分

整套 harness 配置的目的,不是「让每个 agent 都有点工具」,而是**把三条组织规则钉死**:

> **R1. 甲方只与业务经理交互。** 其他任何角色在工具层面就拿不到 `client.ask` / `client.message`。
>
> **R2. 平级之间可以直接沟通;需要拍板时才向上升级。** 项目经理、质检审查员、两个执行角色互为横向通道,用 `ask_role` 自由互通;`escalate` 专用于「我无权决定」,目标由平台按组织图计算,**不越级**。
>
> **R3. 客户可见的角色只有一个。** 「谁该回答这个问题」由 capability 决定,不由提示词决定。

**关键区分**:R2 不是「只能向上」,而是「横向自由 + 纵向受控」。同僚之间对交付标准有分歧不必先升级再由上级转达;但一旦需要有人拍板,就必须走 `escalate`,由平台决定找谁。

这三条在设计 1 §4.3 由 `ScopeGate` 机械保证。下面的角色配置,都只是这个机制的具体化。**R1 是唯一不可协商的一条** —— 横向沟通再自由,甲方那道门也只有一个把手。

---

## 2. 业务经理 `business_manager`

### 2.1 职责

1. 接收甲方诉求(`tell_client` 路径进入)
2. 与甲方对齐,把模糊诉求收敛成可执行的目标(`ask_client` 提结构化问题)
3. **立项** —— `project_open`,产出 `project_brief` 工件作为项目根
4. 受理**所有**升级(`collab.ask` 的唯一合法目标)
5. 组织周期性对焦(`convene`),问「什么时候产出」
6. 向甲方播报进展与结论
7. 提出需求变更

### 2.2 明确不做

- ❌ 不拆解工作项(`work.create` 不在 ceiling 内)—— 那是项目经理的职责边界
- ❌ 不碰代码 —— 不持有任何 `code.*`
- ❌ 不做技术可行性判断 —— 那是两个执行角色与质检的判断

### 2.3 Capability Ceiling

| Capability | 说明 |
|---|---|
| `project.open` | 立项 |
| `project.read` | 读项目全貌 |
| `project.update` | 改 goal / name / status(非终态) |
| `project.close` | 关项目(终态,不可逆) |
| `collab.ask` | 向任意项目内角色提问 |
| `collab.answer` | 回答下属提问 |
| `collab.read` | 查待答提问与升级 |
| `collab.convene` | 发起对焦会议 |
| `collab.meeting.read` | 读会议纪要与各方立场 |
| `collab.meeting.respond` | 参会表态 |
| `collab.meeting.conclude` | 出会议纪要,会议落终态 |
| `blackboard.read` | 读工件 |
| `blackboard.write` | 写 `project_brief` / `decision` / `note` |
| `change.propose` | 提出需求变更 |
| `change.read` | 查变更请求 |
| `blocker.open` / `blocker.update` | 登记与关闭阻塞 |
| `blocker.read` | 查阻塞列表 —— **未解决阻塞向用户反馈的依据** |
| `memory.read` | 检索长期记忆 |
| `memory.write` | 写入长期记忆 —— **仅本角色持有**(见 §11) |
| **`client.ask`** | **向甲方提问** ← 仅本角色持有 |
| **`client.message`** | **向甲方播报** ← 仅本角色持有 |

**writeKinds**:`["project_brief", "decision", "note"]` —— 不写 `evidence` / `review_finding`。`meeting_note` 与 `change_record` 不在其中:它们是 `meeting_conclude` / `change_review` 的**必然产物**,由工具原子创建,不由模型手写(设计 1 §6.2)。

**注意 `project.update` 只给业务经理,不给项目经理。** 项目经理要改范围应该走 `change.propose` —— 那正是 ChangeControl 存在的理由。让项目经理直接改项目目标,等于绕过了变更管理。

### 2.4 出厂工具集合

```json
{
  "allow": [
    "project_open", "project_list", "project_read", "project_update", "project_close",
    "ask_role", "answer", "ask_list", "ask_read",
    "convene", "meeting_read", "meeting_respond", "meeting_conclude",
    "board_list", "board_read", "board_write",
    "change_propose", "change_list", "change_read",
    "blocker_open", "blocker_update", "blocker_list", "blocker_read",
    "memory_search", "memory_remember",
    "ask_client", "tell_client"
  ],
  "deny": ["work_create", "work_update", "work_assign", "work_list", "work_read",
           "report", "read", "grep", "find", "ls", "edit", "write", "bash"]
}
```

**25 个工具。** 注意 `clientFacing: true` 是它能拿到最后两个的唯一原因 —— `ScopeGate` 规则 1。

`deny` 列出它的两条边界:**不拆解工作**(`work.*` 全族)与**不碰代码**(SDK 七件)。业务经理收敛诉求,不排期也不干活。

业务经理是唯一持有 `project_update` / `project_close` 的角色,也是唯一能 `meeting_conclude` 之外还能 `convene` 的**两个**角色之一。

### 2.5 提示词单元

| 单元 | 内容要点 |
|---|---|
| `business_manager.core` | 角色定义:唯一客户接口;职责是收敛诉求而非执行 |
| `business_manager.protocol` | 何时 `ask_client` / 何时 `project_open`;结论必须落 `board_write` |
| `business_manager.align` | 对齐规约:一次只问一个问题、必须给候选项与倾向、禁止把问题原样抛回甲方 |
| `collaboration.convene` | 会议主持规约:明确议题、参会人、要谁表态、结束要出纪要 |

### 2.6 失败模式(来自 7-B / 7-L 的真实现场)

| 失败模式 | 现场证据 | 机制防线 |
|---|---|---|
| 把执行者的升级原样转给甲方 | 7-L 前 `handleWorkerAsk(knowIt=false)` 硬编码,沟通员提示词里的「升级前先自查」从未执行 | 保留并强化 `collaboration.ask` 判断轮:能自答的先自答,判不准才升级 |
| 承诺了没把握的交付时间 | — | `convene` 时要求表态 `支持/反对/待定`,反对必须写理由 |
| 给了个空计划就收工 | 8-E「禁止口头交付」 | `protocol` 明确:结论必须落 `board_write`,播报不替代落库 |

---

## 3. 项目经理 `project_manager`

### 3.1 职责

1. 从业务经理处接立项书
2. **技术 + 业务双向拆解** → `work_create` 建工作分解树与依赖
3. 分派:`assignee_role`(`research_worker` / `coding_worker`)+ `specialization` 指向具体的人
4. 汇总进度 → 向业务经理与甲方(经业务经理)汇报
5. 组织技术层对焦
6. 变更的技术可行性评审

### 3.2 明确不做

- ❌ **不见甲方** —— 无 `client.*`,这是 R1 的直接体现
- ❌ 不写代码
- ❌ 不立项,**也不改项目范围** —— 要改走 `change.propose`,不直接 `project_update`

### 3.3 Capability Ceiling

`project.read` · `work.create` · `work.update` · `work.assign` · `work.read` · `work.list` · `collab.ask` · `collab.escalate` · `collab.answer` · `collab.read` · `collab.convene` · `collab.meeting.read` · `collab.meeting.respond` · `collab.meeting.conclude` · `blackboard.read` · `blackboard.write` · `change.propose` · `change.review` · `change.read` · `blocker.open` · `blocker.update` · `blocker.read` · `memory.read` · `work.report`

> 上表**全部写全名**,不用「`collab.ask` / `escalate` / `answer`」这种继承式简写 —— 这是实现者要照抄的规范列表,简写会让 `collab.meeting.*` 那几条看起来像独立命名空间。

**writeKinds**:`["work_brief", "decision", "note", "deliverable"]`

### 3.4 出厂工具集合

```json
{
  "allow": [
    "project_list", "project_read",
    "work_create", "work_update", "work_assign", "work_list", "work_read", "report",
    "ask_role", "escalate", "answer", "ask_list", "ask_read",
    "convene", "meeting_read", "meeting_respond", "meeting_conclude",
    "board_list", "board_read", "board_write",
    "change_propose", "change_review", "change_list", "change_read",
    "blocker_open", "blocker_update", "blocker_list", "blocker_read",
    "memory_search"
  ],
  "deny": ["ask_client", "tell_client", "project_update", "project_close"]
}
```

**27 个工具。** `deny` 里显式列了四项,都是**它拿不到且不该拿到**的:对甲方说话的两个,和改项目范围的两个(改范围要走 `change_propose`)。这是有意的可见性 —— 比让它们在 UI 上「不存在」更能说明边界。

### 3.5 提示词单元

| 单元 | 内容要点 |
|---|---|
| `project_manager.core` | 角色定义:技术+业务双视角拆解;不碰代码 |
| `project_manager.protocol` | 拆解质量判据:每项工作有明确产出物与可验证判据;依赖要显式 |
| `collaboration.ask` | 升级规约:向业务经理升级必须带 hypothesis 全文 + 候选项 |
| `collaboration.convene` | 技术层对焦主持 |

### 3.6 失败模式

| 失败模式 | 现场证据 | 机制防线 |
|---|---|---|
| 重复规划已在做的事 | 现状 `planner` 只给 `board_list`+`board_read` 就是为了这个 | 保留;`protocol` 要求开工前先 `board_list` 查重 |
| 拆解出的 todo 无 assignee | 现状 `todo` 不带 assignee,角色概念不存在 | `work.create` 的 `assignee_role` 为**必填**,schema 层面拒绝无主工作 |
| 进度只在嘴上,黑板上不更新 | 8-C 之前「用户跑到结束才第一次看见结果」 | `work.update` 状态变更是 `report` 的前置;播报不替代落库 |

---

## 4. 研究工 `research_worker`

> **2026-10-08:执行角色按「产出形态」一分为二。** 原来那一个 `worker` 改名成
> 研究工(它交的是**信息**),另起一个编码工 `coding_worker` 交**能跑的东西**。
> 为什么是两个角色而不是给一个角色加个字段:角色是**权限面的最小单位**
> (ceiling / writeKinds / promptUnits 都挂在它上面),而这两件事的权限面真的不同。
> 详见设计 1 §6.4 与两条迁移记录(`migrations/026`)。

### 4.1 职责

1. 对分派到自己的工作项交付负责
2. 把项目经理分派来的工作项做**研究层再拆解**(要不要拆成几段调研、要不要先取数据)
3. **亲自执行** —— 读资料、读代码、跑命令把事实取到手
4. 产出**交付物**:技术方案、架构图、调研结论、汇报材料、伪代码 —— 形态是一份
   `kind='deliverable' + deliverableType='html_report'` 的 HTML 报告
5. 产出支撑材料(`evidence`)与未证实的判断(`hypothesis`)
6. 卡住时向上升级,**不越级见甲方**
7. 参与技术评审

### 4.2 明确不做

- ❌ 不立项
- ❌ **不见甲方** —— 无 `client.*`
- ❌ 不决定需求范围 —— 只提 `change.propose`,不决定
- ❌ **不产出产品代码** —— 无 `code.write`(`edit` / `write` 不在工具面上)。
  产品代码是编码工的产出:研究工改了,它既没有评审、也没有进任何交付物

### 4.3 Specialization

`engineering` | `algorithm` | `data`

它与「研究 / 编码」那条轴**正交**:角色说的是**产出形态**,细分说的是**领域**。
两个执行角色都可以带细分。

### 4.4 Capability Ceiling

`project.read` · `work.create` · `work.update` · `work.read` · `work.list` · `collab.ask` · `collab.escalate` · `collab.answer` · `collab.read` · `collab.meeting.read` · `collab.meeting.respond` · `blackboard.read` · `blackboard.write` · `change.propose` · `change.review` · `change.read` · `blocker.open` · `blocker.update` · `blocker.read` · `memory.read` · `code.read` · `code.exec` · `work.report`

**writeKinds**:`["evidence", "hypothesis", "work_brief", "note", "deliverable"]`

**注意它与编码工的唯一差别是 `code.write`。** 它持 `code.read`(读代码才画得出
架构图、写得出伪代码)与 `code.exec`(跑命令才取得到资料),但**不持 `code.write`**。

> ⚠️ **这条边界是「表达意图」的,不是沙箱。** `code.exec` 里的 `bash` 当然也能改文件。
> 之所以仍然这么划:研究工要写的是**说明性材料**,而「产出产品代码」是编码工的活。
> 真正带牙齿的机械区分在**交付物类型**上 —— `code_service` 必须指向一个真的
> git 仓库 + Dockerfile,由平台当场核对(设计 1 §6.4);不是「写个 type 字段」就成立。

**注意它有 `collab.meeting.respond` 但没有 `collab.meeting.conclude`** —— 它能表态,不能替主持人收尾。

### 4.5 出厂工具集合

```json
{
  "allow": [
    "project_list", "project_read",
    "work_create", "work_update", "work_list", "work_read", "report",
    "ask_role", "escalate", "answer", "ask_list", "ask_read",
    "meeting_read", "meeting_respond",
    "board_list", "board_read", "board_write",
    "change_propose", "change_review", "change_list", "change_read",
    "blocker_open", "blocker_update", "blocker_list", "blocker_read",
    "memory_search",
    "read", "grep", "find", "ls", "bash"
  ],
  "deny": ["tell_client", "ask_client", "convene", "meeting_conclude", "project_update", "project_close", "edit", "write"]
}
```

**31 个工具。** `deny` 里显式写了八项,都是**它拿不到且不该拿到**的:对甲方说话的两个、发起与收尾会议的两个、改项目范围的两个,以及**写文件的两个**(那是编码工的活)。写进 `deny` 是为了**让用户在 UI 上一眼看到边界**,而不是只看到一串没有的绿 chip。这是有意的可见性设计。

### 4.6 提示词单元

| 单元 | 内容要点 |
|---|---|
| `research_worker.core` | 角色定义:交的是**信息**;交付物是 HTML 报告;事实来自工具 |
| `research_worker.protocol` | 交付物与依据分开写;HTML 报告的四条硬约束;不交口头结论 |
| `collaboration.ask` | **卡住时你求助的对象是上游,不是甲方**;必须带 hypothesis 全文 + 候选项 + 说清要什么 |
| `change.propose` | 发现需求不合理时的上报规约 |

### 4.7 失败模式 —— 这一段是全项目最贵的历史沉淀

| 失败模式 | 现场证据 | 机制防线 |
|---|---|---|
| 交出的产出「信封摆错」被判失败 | 7-D 缺省 / 7-M 空串 / 7-M 套对象,三次把写完的调研报告当 parse 失败丢掉 | **结构性解法**:不再交 `{outcome}` 让框架猜,改为直接调 `board_write(kind, title, body)`,schema 校验失败由 SDK 回灌给模型 |
| 工具轮记不住自己查过什么,原地打转 | 7-N 事故:transcript 每轮从 `opts.userPrompt` 重拼,模型第 N 轮只看得到第 N-1 轮,6 轮用尽仍不收敛 | 上下文必须累积而非每轮重拼;排查「不收敛」先怀疑上下文,不要先动轮数上限 |
| 失败不留现场 | 7-N 之前未收敛的 note 只有一句「未收敛」 | `blocker.open(detail)` 必须带工具调用记录(次数/名称/失败原因) |
| 提示词教它用不存在的工具 → 编造 | 8-A 事故:集合文件声称 13 个工具、循环里真的只有 6 个 | **不变式测试**:集合文件声称的工具必须真的在工具池里,否则测试红 |
| 升级找错了人 | 7-L | `collaboration.ask` 的 `targetRole` 受 `ScopeGate` 限制,必须是同项目角色;且默认提示是上游 |
| **交了一份空白页的 HTML 报告** | 模型爱写 `<script>` 画图,而渲染面是**禁用脚本的沙箱** | 写入层 `validateHtmlReport` 当场拒收带 `<script>` 的正文,并把可执行的处置回灌给它 |
| **只留了一堆 `evidence`、交付物不存在** | 部门口口声声「做完了」,而甲方手上什么都没有 | `integrate` / `handover` 与项目收口**按 `deliverable` 工件**判断,不按 `evidence` |

---

## 5. 编码工 `coding_worker`

### 5.1 职责

1. 对分派到自己的工作项交付负责
2. 把项目经理分派来的工作项做**技术层再拆解**
3. **亲自执行** —— 读代码、改代码、跑命令、建仓库、构建镜像
4. 产出**交付物**:**代码服务** —— 一个真的 git 仓库,能独立部署到 Docker 上
   (`kind='deliverable' + deliverableType='code_service'`)
5. 产出验证现场(`evidence`):构建日志、测试输出、跑起来的证据
6. 卡住时向上升级,**不越级见甲方**
7. 参与技术评审

### 5.2 明确不做

- ❌ 不立项
- ❌ **不见甲方** —— 无 `client.*`
- ❌ 不决定需求范围 —— 只提 `change.propose`,不决定

### 5.3 Specialization

同研究工:`engineering` | `algorithm` | `data`。两个执行角色共用同一条领域轴。

### 5.4 Capability Ceiling

`project.read` · `work.create` · `work.update` · `work.read` · `work.list` · `collab.ask` · `collab.escalate` · `collab.answer` · `collab.read` · `collab.meeting.read` · `collab.meeting.respond` · `blackboard.read` · `blackboard.write` · `change.propose` · `change.review` · `change.read` · `blocker.open` · `blocker.update` · `blocker.read` · `memory.read` · `code.read` · `code.write` · `code.exec` · `work.report`

**writeKinds**:`["evidence", "hypothesis", "work_brief", "note", "deliverable"]`

**与研究工的唯一 ceiling 差别是 `code.write`(展开成 `edit` / `write` 两个工具)。**

**注意它有 `collab.meeting.respond` 但没有 `collab.meeting.conclude`** —— 同上,它能表态不能收尾。

### 5.5 出厂工具集合

```json
{
  "allow": [
    "project_list", "project_read",
    "work_create", "work_update", "work_list", "work_read", "report",
    "ask_role", "escalate", "answer", "ask_list", "ask_read",
    "meeting_read", "meeting_respond",
    "board_list", "board_read", "board_write",
    "change_propose", "change_review", "change_list", "change_read",
    "blocker_open", "blocker_update", "blocker_list", "blocker_read",
    "memory_search",
    "read", "grep", "find", "ls", "edit", "write", "bash"
  ],
  "deny": ["tell_client", "ask_client", "convene", "meeting_conclude", "project_update", "project_close"]
}
```

**32 个工具。** `deny` 里六项:对甲方说话的两个、发起与收尾会议的两个、改项目范围的两个。

### 5.6 提示词单元

| 单元 | 内容要点 |
|---|---|
| `coding_worker.core` | 角色定义:交的是**能跑的东西**;代码服务的坐标;「能部署」的机械判据是构建过一次 |
| `coding_worker.protocol` | 交付物坐标 = 平台核实过的事实;正文写什么(含「还没验证的部分」);不交口头结论 |
| `collaboration.ask` | 卡住时求助的是上游,不是甲方 |
| `change.propose` | 发现需求不合理时的上报规约 |

### 5.7 失败模式

| 失败模式 | 防线 |
|---|---|
| **写一条指向不存在仓库的交付物** | 写入层调 `codeservice` 端口去盘上核对(存在 / 是 git / HEAD 一致 / 分支顶端 / 有 Dockerfile),核对不过写不进去 |
| 「有个 Dockerfile 就算能部署」 | 提示词要求**构建一遍再交**;构建不了就在正文里如实写明「未验证」 |
| 交付物坐标凭记忆写 sha | 平台核对 `headCommit`,不一致当场拒收并**告诉它真实 sha** |
| 代码躺在磁盘上、黑板上没有交付物 | `work.update(done)` 之后平台按 `deliverable` 工件判交付;少了它收口判据不成立 |
| 越权直接改项目范围「顺手调一下」 | ceiling 无 `project.update`;UI 的 `deny` 明写出来 |


## 6. 质检审查员 `quality_reviewer`

### 6.1 定位

**这是本次全新建设的角色**(对应旧的 `critic`,此前零实现)。它在一个组织里承担的是「交付前的独立把关」—— 不能自己审自己的活。

### 6.2 职责

1. 对交付物做符合性审查:是否满足原始目标、验收判据是否成立
2. 产出 `review_finding` 工件
3. 参与技术评审与对焦会议
4. 变更的符合性评审(是否真的按变更执行了)
5. 发现严重问题 → 向项目经理或业务经理升级

### 6.3 明确不做

- ❌ 不碰代码 —— 只读不写,审的是产出物不是源码
- ❌ 不拆工作
- ❌ **不见甲方** —— 审查结论由业务经理转达
- ❌ **不能自己修** —— 只能提意见,修复是执行角色(研究工 / 编码工)的事

### 6.4 Capability Ceiling

`project.read` · `work.read` · `work.list` · `collab.ask` · `collab.escalate` · `collab.answer` · `collab.read` · `collab.meeting.read` · `collab.meeting.respond` · `blackboard.read` · `blackboard.write`(**仅 `review_finding`**)· `change.review` · `change.read` · `blocker.open` · `blocker.read` · `memory.read` · `work.review_verdict`(migration 021)

**writeKinds**:`["review_finding"]` —— **只允许写这一种工件**。这是三重门控(capability × scope × writeKind)里最窄的一个,设计上有意为之:审查员能发言,但不能污染其他记录。

**它有 `collab.meeting.respond` 但没有 `collab.convene` / `collab.meeting.conclude`** —— 能被叫去开会并表态,但不能发起、也不能替主持人收尾。

> **`work.review_verdict` 让「审出了什么」成为一行结构化事实**,而不是只躺在 `review_finding` 的正文里。真机事故(2026-10-06 08:57):质检判**不通过**、6 条验收判据 0 条达成、审查意见 3352 字,而平台把那条工作项标成了**已审** —— 因为 `markWorkReviewed` 的判据是「质检回合成功结束」而不是「判通过」,不通过因此没有任何读者(死信)。`review_verdict` 就是那个读者:调用它写一行,`pass` 让平台标已审,`fail` 让平台走 `works.status` 唯一写口**重开**这条工作项。⚠️ 它**不持 `work.update`** —— 边界没松:质检能**说**它不合格,不能**自己改**它。
>

### 6.5 出厂工具集合

```json
{
  "allow": [
    "project_list", "project_read",
    "work_list", "work_read",
    "ask_role", "escalate", "answer", "ask_list", "ask_read",
    "meeting_read", "meeting_respond",
    "board_list", "board_read", "board_write",
    "change_review", "change_list", "change_read",
    "blocker_open", "blocker_list", "blocker_read",
    "memory_search",
    "review_verdict"
  ],
  "deny": ["convene", "meeting_conclude", "read", "grep", "find", "ls",
           "edit", "write", "bash", "tell_client", "ask_client",
           "project_update", "project_close", "work_create", "work_update", "work_assign"]
}
```

**21 个工具。** `deny` 显式列出代码工具、会议主持、项目范围与工作分派 —— 审查员可以**参加**会议但不能**发起或收尾**,可以**看**工作项但不能**创建或改派**。

### 6.6 提示词单元

| 单元 | 内容要点 |
|---|---|
| `quality_reviewer.core` | 角色定义:独立把关;审产出不审源码;只提意见不自己修 |
| `quality_reviewer.protocol` | 审查判据:对照原始目标与验收判据;结论必须有据;通过与不通过都要写清理由 |
| `collaboration.ask` | 升级规约:严重问题才升级,一般问题走 `review_finding` |

### 6.7 失败模式

| 失败模式 | 防线 |
|---|---|
| 变成橡皮图章,什么都通过 | `protocol` 要求「不通过也要写清理由」;审查意见是必落工件,不能只在对话里说一句 |
| 越权直接改代码「顺手修一下」 | ceiling 无 `code.*`,UI 的 `deny` 明写出来 |
| 审查结论直接发给甲方 | 无 `client.*`;只能经业务经理 |

---

## 7. 被删除的角色

| 旧角色 | 处置 | 理由 |
|---|---|---|
| `memory` | **删除** | 记忆是 `memory.read` / `memory.write` 两个 capability,不是一个 agent。做成 agent 会导致「谁决定记什么」这种无主问题。 |
| `reflection` | **删除** | 零实现。反思的合理形态是会议纪要(`collab.convene` + `collab.meeting.conclude`),不是独立 agent。 |
| `harness_manager` | **删除** | 574 行、已 boot、但全仓无 `harness_proposal` 发射点,永不触发。harness 的升级入口改由 Harness 页 + 设计 1 §7 的三层结构承担。 |

> **删除不是「不做了」,是「不该做成 agent」。** 这三者的问题都是「把一件事做成一个角色」,于是它需要一个负责人、需要一个触发源、需要一个失败语义 —— 而它们本该是能力或流程。

---

## 8. Capability × 角色 总矩阵

| Capability | 业务经理 | 项目经理 | 研究工 | 编码工 | 质检审查员 |
|---|:--:|:--:|:--:|:--:|:--:|
| `project.open` | ✅ | — | — | — |
| `project.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `project.update` | ✅ | — | — | — |
| `project.close` | ✅ | — | — | — |
| `work.create` | — | ✅ | ✅ | ✅ | — |
| `work.update` | — | ✅ | ✅ | ✅ | — |
| `work.assign` | — | ✅ | — | — |
| `work.read` / `work.list` | — | ✅ | ✅ | ✅ | ✅ |
| `collab.ask` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `collab.answer` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `collab.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `collab.escalate` | — | ✅ | ✅ | ✅ | ✅ |
| `collab.convene` | ✅ | ✅ | — | — | — |
| `collab.meeting.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `collab.meeting.respond` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `collab.meeting.conclude` | ✅ | ✅ | — | — | — |
| `blackboard.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `blackboard.write` | ✅ | ✅ | ✅ | ✅ | ✅ *(仅 review_finding)* |
| `change.propose` | ✅ | ✅ | ✅ | ✅ | — |
| `change.review` | — | ✅ | ✅ | ✅ | ✅ |
| `change.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `blocker.open` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `blocker.update` | ✅ | ✅ | ✅ | ✅ | — |
| `blocker.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `memory.read` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `memory.write` | ✅ | — | — | — |
| `work.report` | — | ✅ | ✅ | ✅ | — |
| `work.review_verdict` | — | — | — | — | ✅ |
| `code.read` | — | — | ✅ | ✅ | — |
| `code.write` | — | — | — | ✅ | — |
| `code.exec` | — | — | ✅ | ✅ | — |
| **`client.ask`** | **✅** | — | — | — | — |
| **`client.message`** | **✅** | — | — | — | — |

**共 34 条 capability。** 读这张表最该看的是**最后两行** —— 整个组织里只有一个角色能跟甲方说话,这不是提示词里的约定,是这张表的形状决定的。

三处值得单独注意:

- **`collab.escalate` 业务经理是空的** —— 它上面没有人了,升级出口是 `client.ask`。其余四个角色的 `escalate` 目标由平台计算,**模型无法指定**,所以「不越级」是机制保证的(设计 1 §5.3)。
- **`project.update` / `project.close` 只有业务经理** —— 项目经理要改范围必须走 `change.propose`,不能直接改项目目标。这是让变更管理有意义的必要条件。
- **`collab.meeting.conclude` 与 `collab.meeting.respond` 分离** —— 参会者能表态,只有主持人能收尾。否则「会议结论」没有责任人。

`memory.write` 只给业务经理,理由见 §11。

---

## 9. 写面权限(writeKinds)

| 角色 | 可写工件 kind |
|---|---|
| 业务经理 | `project_brief` · `decision` · `note` |
| 项目经理 | `work_brief` · `decision` · `note` · `deliverable` |
| 研究工 | `evidence` · `hypothesis` · `work_brief` · `note` · `deliverable` |
| 编码工 | `evidence` · `hypothesis` · `work_brief` · `note` · `deliverable` |
| 质检审查员 | `review_finding` |

**`deliverable` 从 2026-10-08 起有三个角色持有。** 项目经理仍然做**整合交付**(把子项产出收成一份);两个执行角色持有它,是因为它们各自就是「一份 HTML 报告 / 一个代码服务」的**产出的那个人** —— 一份报告是研究工写出来的,不是项目经理替它写的。质检仍然只写 `review_finding`。

**不在此表的 kind 由协议工具原子创建,模型写不了**:`client_question`(`ask_client`)· `meeting_note`(`meeting_conclude`)· `change_record`(`change_review` 判 accepted)。`decision` 是唯一两边都可的(见设计 1 §6.2)。

**不变式**:`blackboard.write` 的 kind 参数必须落在该角色的 `writeKinds` 内,否则工具调用返回结构化错误并把合法 kind 列表回灌给模型 —— 沿用 8-F 的教训(工具协议段必须渲染参数清单,否则模型会传错参数名)。

---

## 10. 每个角色的会话与执行剖面

| 角色 | 触发时机 | 工具循环 | 典型一次回合 |
|---|---|---|---|
| 业务经理 | 甲方消息 / 下属升级 / 会议结论 | ✅ | 收到执行角色提问 → 跑判断轮 → 能自答则 `answer`,不能则 `ask_client` |
| 项目经理 | 业务经理立项 / 工作项完成 / 会议纪要 | ✅ | 读立项书 → `work_create` 拆解(按产出形态派给研究工或编码工)→ `report` 进度 |
| 研究工 | 有分派工作项 / 被提问 / 被提问升级 | ✅ | 读工作项 → 读资料与代码 → `board_write(deliverable/html_report)` → 遇阻 `ask_role` |
| 编码工 | 有分派工作项 / 被提问 / 被提问升级 | ✅ | 读工作项 → `code.*` 干活 + 建仓库 + 构建 → `board_write(deliverable/code_service)` → 遇阻 `ask_role` |
| 质检审查员 | 工作项转「待审」/ 会议 / 被点名 | ✅ | `board_read` 目标与产出 → `board_write(review_finding)` → `review_verdict` |

**全部五个角色都走工具循环。** 现状是只有 `communicator` 一个角色 `enforced: true`,其余六个 `enforced: false`(「已就位、未接线」)。本次升级后应当**取消 `enforced` 这个字段本身** —— 四角色全部真实接线,再区分「已接线/未接线」就没有意义了,留着反而会再次诱发「给没接线的角色写一份假装生效的名单」。

---

## 11. 记忆:是什么、是谁的、谁写

> **本轮范围(2026-10-03 决策)**:记忆系统**做简单实现 + 预留接口**,不做复杂设计。技术侧的端口定义见设计 1 §8.3。本节只定「是什么、谁写」,不展开实现。

### 11.1 是什么

**记忆 = 关于「用户」的长期知识,不是任何 agent 自己的记忆。**

四个角色共享同一个用户,也就共享同一份记忆。它记的是:用户是谁、偏好什么、项目背景是什么。这跟 agent 的「上下文」不是一回事 —— 上下文随回合消失,记忆跨回合、跨项目存在。

### 11.2 与工件的区别

| | 记忆(`fragments`) | 工件(`artifacts`) |
|---|---|---|
| 记什么 | 关于用户的事实/偏好/背景 | 关于**这个项目**的决策/产出/会议/变更 |
| 生命周期 | **可衰减**(`decayFactor`) | **不衰减**(状态机到终态即永久) |
| 归属 | 跨项目,不属于任何单个项目 | 属于某个 project |
| 谁写 | `memory.write` / 自动沉淀 | `board_write` / 协议工具 |

**「可衰减 vs 不衰减」是判据**:用户偏好明年可能就变,所以记忆要能淡忘;一份已签字的决策永远有效,所以工件不能淡忘。这条区别决定了它们是两个存储,而不是同一张表加个 flag。

### 11.3 修掉现状的「两套记忆割裂」

现状有两条割裂的写路径(8-D 审计项 M5):

| 路径 | 写到哪 | 问题 |
|---|---|---|
| `extractFragments`(正则) | `fragments` 表 | 只能匹配「记住:/我叫/我喜欢」这类固定句式 |
| `sedimentTurn`(LLM 沉淀) | `insight` **工件** | 写进项目黑板,但内容是关于用户的 —— 放错了存储,且随项目一起消失 |

**处置**:统一进 `fragments`。`sedimentTurn` 改为产出 fragment 而非 insight artifact,`insight` 这个 artifact kind 删除。理由是记忆归用户、项目归项目 —— 一个关于「用户喜欢用 TypeScript」的记忆写进某个项目的黑板,项目一关这条知识就没了,这是错的。

### 11.4 谁写

| 写入者 | 写什么 | 方式 |
|---|---|---|
| **业务经理** | 关于**用户**的一切 | `memory.write` 主动调用(唯一持有者) |
| 平台沉淀 | 正则快路径 + LLM 兜底 | 自动,覆盖业务经理漏掉的 |

**为什么只给业务经理**:它是对甲方唯一接口,最清楚「用户是谁、想要什么」。而执行角色在干活中学到的东西是**工程事实**(「这个仓库的测试要用 `npm test`」),那属于项目知识,应该走 `board_write(kind=note)`,不该污染用户记忆。

这个区分很实际:用户记忆决定了 agent「怎么跟这个人打交道」,项目知识决定了「这个项目怎么推进」。混在一起,两边都会失焦。

### 11.5 本轮只做三件事

1. `extractFragments` 正则快路径 + bigram 检索(**已有,保留**)
2. `sedimentTurn` 改写到 `fragments`,删 `insight` artifact 路径
3. 抽出 `MemoryPort` 接口,上层只依赖接口

**明确不做**:向量检索、衰减调度、去重合并、跨项目记忆融合。这些都留给 `MemoryPort` 的后续实现 —— 换成第三方记忆系统时,agent 代码一行不用改。

---

## 12. 未决问题(2026-10-08 更新状态)

> 跨文档的同一问题在设计 1 §12「未决问题」里也有条目,两处已互相标注。

1. **执行角色要几个?** 一项目内工程/算法/数据各一个,还是按工作量增减?影响 `project_assignments` 的约束。 — **部分解决**。2026-10-08 先把**产出形态**那条轴拆开了(研究工 / 编码工各一人,与领域无关);「同一条轴内要不要多个人」仍未决。

2. **质检审查员的独立性怎么保证?** 它与项目经理是平级还是有汇报关系?若同一模型扮演两者,「审自己的活」的风险是模型层面的,机制层管不了。 — **仍未决,且已确认机制层无解**

   现在的机制只能做到三件事:`quality_reviewer` 没有 `code.write`(所以它不能顺手改)、只能写 `review_finding`(所以它的产出形态是受限的)、没有 `client.*`(所以它不能直接对甲方下结论)。但「它会不会认真审」是模型行为,不是权限问题。**这条要在 prompt 层解决,而且解决不彻底** —— 如实记着比假装解决了强。

3. **周期对焦的触发方式**:定时器自动发起,还是业务经理手动召集?前者需要一个调度器,本次设计未包含。 — **仍未决;已记为设计 1 §12 #6「调度器的巡检策略」**

   **前置依赖已查明**:平台侧没有任何长驻进程(`bootPlatform` 只有 CLI 一个调用方,`src/platform/` 内无 `setInterval`/daemon)。没有宿主进程时,调度器写出来就是死代码。前置是设计 1 §10.3 的阶段 12(传输层 + 宿主)。

4. **业务经理的立项是否要用户确认?** `project_open` 是直接执行,还是先出立项书给甲方过目再落库?后者多一步但基线更稳。 — **仍未决**

   一个观察:提示词单元 `business_manager.core` 已经要求「立项前先能回答做成什么样算成 / 不做什么 / 甲方怎么知道」,但那是**提示词层的自查**,不是机制。若要让「立项书必须经甲方确认」成为机制,得在 `project_open` 上加一个调用期门(类似 `kind` 白名单那种),而不是再写一句提示词。

5. **横向沟通要不要留痕约束?** 现在 `ask_role` 横向畅通,但「同级之间聊了什么」是否需要默认落一条记录、还是仅在升级时才强制落库?留痕太密会淹没审计面,太疏则横向协调变成黑箱。 — **仍未决;与设计 1 §12 #3「横向沟通的留痕密度」同题**
