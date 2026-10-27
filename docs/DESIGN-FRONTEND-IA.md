# DESIGN-FRONTEND-IA · 前端的注释预算与实体脊

> 这份文档只回答两件事:**屏幕上那些解释性文字怎么收**,以及**同一批实体怎么在页与页之间连起来**。
> 它不改配色、字号、间距体系(`web/src/styles/tokens.css` 46 行 + `globals.css` 555 行照旧),
> 不改任何 HTTP / WS 契约,不改数据库。**服务端一行都不动。**
>
> 判据一律可执行:每一节末尾的「判据」都能变成一条会红的测试。文档不是意图声明 ——
> 本项目已经为「代码里写了但没读者」「检查坏了却返回看起来正常的答案」付过太多代价。

---

## 0. 现状事实(改之前先认账)

| 事实 | 坐标 / 数字 |
|---|---|
| 6 个 tab:对话 / 项目 / 工作项 / 成员 / 记忆 / 设置 | `web/src/components/shell/TopBar.tsx:41-48` |
| 路由态是 `useState`,**没有 URL** | `web/src/App.tsx:64` 的 `const [route, setRoute] = useState<Route>("chat")` |
| `react-router-dom@^6.30.6` 是**已安装依赖但零引用** | `package.json:50`;`grep -rn 'react-router' web/src` 为空 |
| 选中态是页面私有的 | 工作项页 `web/src/routes/Works.tsx:1780` 的 `picked`、`:1782` 的 `openId`;成员页 `web/src/routes/Members.tsx:915` 的 `activeId` |
| 页面级说明文字 131 处(`hint=` / `hintTitle=` / `<Disclosure>` / `className="ss-note"`) | 其中 6 处在 `web/src/components/ui/primitives.tsx` 自身 ⇒ **125 个调用点** |
| `hintTitle` 的取值常是 200–400 字的工程说明 | 例:`web/src/routes/Works.tsx:1748` 的推进图 `hintTitle` 一整段 |
| `primitives.tsx` 已经立过「注解默认不在屏幕上」的规矩 | `web/src/components/ui/primitives.tsx:10-25` |
| 同一实体在多个页面各渲染一遍 | 工作项:项目页(`ProjectDetail.tsx:416`)+ 工作项页;工件:工作项页 + 成员页 |
| 三张画布,两套选中模型 | `lib/workGraph.ts` / `lib/artifactGraph.ts` / `lib/timeline.ts` |

**结论:规矩立了,落地手段错了。** `primitives.tsx` 给的两条出口是 `title=`(悬停)**和**
`<Disclosure>`(点开)。`title=` 有三个硬伤 —— 触屏不触发、不可选中复制、屏幕阅读器行为不一致;
再叠上「一句话说不清就写三段」的用法,结果是**把正文搬成了悬停正文**:默认看不见,一悬停是一堵墙。
`<Disclosure>` 略好,但它要求读者先意识到「这里有东西可点」,而折叠的往往是**这东西到底可不可信**的判据。

---

## 1. 两条根因

### 1.1 注释的根因:我们把**工程师的举证责任**写进了界面

「读不到 ≠ 空闲」「内部提问不用你处理」「这张图第三类边 0 条」「只读观测 · 不设上界」——
这些**事实**一条都不能放松(它们分别是 `ProjectLiveView.runtime`、`AskView` 与
`ClientQuestionView` 的分家、`web/src/lib/artifactGraph.ts:16-29` 的 0 边纪律、成本观测不设上界的裁决)。
但它们的读者不是甲方。甲方需要的是一个**信号**:*这个数字现在能不能信*。

> **形态是信号,句子不是。** 「读不到」与「真的是 0」的差别应该由**渲染形态**承载(斜纹 / 问号 /
> 留白 / 骨架),而不是由每个调用点记得补一句小字。今天这句话被写了 N 遍、N 个页面各写一种措辞,
> 而任何一处漏写都不会红 —— 这正是「声明有了、读者没有」的老病。

**判据(反例):** 一个页面同时出现「加载中…」小字与「暂无数据」小字,且两者字形相同 ⇒ 读者无法区分
「还没查」与「查过了,是空」。今天这个判据在 4 个页面各靠散文满足一次。

### 1.2 关联的根因:实体**没有地址**,选择态**不共享**

「系统性关联」在界面上的最低要求是:**从一个东西,能一步走到与它有关的另一个东西,并且走回来。**
今天两件事都不成立:

- **没有地址** ⇒ 不能从工作项跳到它的工件、再跳到工件的作者;刷新即丢;不能把「这条为什么卡住」的
  链接发给别人(甲方本人就是这种场景)。
- **选择态是页面私有的** ⇒ 在「工作项」点中 W-12,切到「成员」,那个人的面板不落在 W-12 上。
  用户感觉是**五个互不相干的抽屉**,而不是一个组织。

⇒ 这不是排版问题,**是缺少一层「实体脊」**:`项目 → 工作项 → 工件 → (质检结论 / 甲方裁决) → 作者`,
外加一条 `成员 → 他的发言 → 他产出的工件`。

---

## 2. 第一刀:注释预算

### 2.1 `<DataState>` 原语(吃掉最大的一类说明文字)

新增 `web/src/components/ui/DataState.tsx`:

```
<DataState state="unknown" | "loading" | "empty" | "error" | "ready" ... />
```

- 四态**形态不同**:`unknown`(读不到)斜纹底 + 问号图标 + `title` 只放「读不到」三个字;
  `empty` 留白 + 一句 ≤ 12 字的空态;`loading` 骨架;`error` 朱砂色左边条 + `error` 原文。
- **`unknown` 与 `empty` 的 DOM 形状不同**,由组件保证;调用点不可能「忘了说」。
- 出处必须是 `Loaded<T>` 的三态(`web/src/lib/data.ts` 的 `useLoad`,见其文件头的「还没查过 ≠ 查过了是空」),
  **不许**调用点自己 `if (arr.length === 0)` 猜。

**判据:** `tests/web/data-state.test.ts`
① 同一个 `state="unknown"` 与 `state="empty"` 渲染出的 `data-state` 属性与文本**都不相同**;
② 负样本:`state="ready"` 且 `children` 为空时**不**渲染成 `empty`;
③ 变异自检:把 `unknown` 与 `empty` 的形态改成同一个 class ⇒ 红。

### 2.2 词汇表(`glossary`)+ `<Help>` 弹层,废掉 `hintTitle`

- 新增 `web/src/lib/glossary.ts`:`id → { line: string ≤ 24 字, basis: string, source: string }`
  (`basis` = 判据落在哪个文件/函数,`source` = 哪个端点或哪张表)。**全站唯一一份。**
- 页面里只剩 `line` 和一个可点的 `?`;点开是三行结构化内容。**不许再写 `hintTitle=`。**
- 角色名仍只走 `ORG` / `ROLE_LABEL`(`web/src/lib/vocab.ts`)—— 词汇表**不重复**任何已有的名字表,
  它只装「解释」,不装「命名」。这条与「角色中文名只有一处」同源。

**判据:** `tests/web/glossary.test.ts`
① 每个 `glossary` 条目的 `basis` / `source` 非空;
② `grep -rn 'hintTitle=' web/src` = 0(带正样本自检:先把一个 `hintTitle=` 写进内存字符串,断言搜索器能命中);
③ 变异自检:删掉一个 `basis` ⇒ 红。

### 2.3 注释预算(让「过多」变成一次红灯)

**判据:** `tests/web/annotation-budget.test.ts`(**已实现 11 条**;下面这两条是原计划)
- ~~`hint` 长度 ≤ 24~~ ⇒ **已废**(见下「实施记录」):字長不是判据;真正钉住的是
  「出处不许进 `hint`」(`hint="…GET /api…"` = 0)。「每页 ≤ 6 条 hint」**尚未实现**;
- 源码禁止 `hintTitle=` ✅(已实现,带正样本自检);
- JSX 内**连续中文散文文本节点 > 60 字** ≤ 8:`ss-note` 实测 **40 条**(不是≥ 26),
  这一条**尚未实现**(它需要 AST,不是 grep);
- **变异自检** ✅ 已实测三条变红(见 §8.3)。

### 2.4 一张「关于这些数字」页

顶栏一个 `?` → `GET /api/...` 之外的**纯静态**页面,三节:

1. **四态的含义**(读不到 / 还没查 / 真的是 0 / 出错);
2. **每个数字的来源**(`glossary` 全表:一句话 + 判据落点 + 数据来源);
3. **已知的不实之处**(如实列:交付时记的 HEAD 是那一刻的事实、`parent` 这列零写入侧、MCP 连接状态读不到…)。

反造假纪律**一个字不减**,只是从「40 处脚注、逐页读」变成「一处、想查时查」。这是这一刀唯一的**收益声明**,
也是它唯一的**代价声明**:有人会说「以前页面上直接写着,现在要多点一下」。那句话是对的,而且是有意的。

---

## 3. 第二刀:实体脊

### 3.1 地址化(一切关联的前置条件)

`/p/:projectId/:tab?/:entityId?`(`web/src/App.tsx` 换成 `react-router-dom`,依赖已在)。

- `tab ∈ chat | project | works | members | memory | settings`(**与 `TopBar.tsx:41-48` 的 `TABS` 同一个 union**,
  不新开一张表);`entityId` 由 `tab` 解释(`works` → workId,`members` → agentId)。
- 刷新、返回键、深链全部免费获得。
- **不做**:不做「一条 URL 装下全部选中态」。工件详情走**抽屉**(3.3),它的 id 进查询串
  (`?a=<artifactId>`),不进路径 —— 抽屉是覆盖层,不是一站。

**判据:** `tests/web/routes.test.ts` —— 给定 URL ⇒ 渲染的分支;反向:给定 selection ⇒ 生成的 URL;
**往返恒等**(URL → state → URL 不变),这是防「两处各写一份」的唯一有牙判据。

### 3.2 共享选择态

新增 `web/src/stores/selection.ts`:`{ projectId, workId, artifactId, agentId, tab }`。

> **tab 是视图,selection 是主体。** 切 tab 不改变选中的人 / 环节 / 工件;换项目**清空**后三者
> (它们都指向旧项目的 id —— `web/src/routes/Works.tsx:1787-1790` 今天已经手写了一遍,改成一处)。

**判据:** `tests/web/selection.test.ts` —— ① 切 tab 后 `workId` 不变;② 换项目后三个 id 全为 null;
③ 变异自检:让「换项目不清空」⇒ 红。

### 3.3 `<EntityInspector>` + 关系词表

- 新增 `web/src/lib/relations.ts`:`RELATIONS[kind]` = `{ rel, target, ids(data) }[]`,**只从库里真有列的关系出发**。
- 新增 `web/src/components/shell/EntityInspector.tsx`:右侧抽屉,三段 —— **事实(KV)/ 关系(chips)/ 动作**。
  点 chip ⇒ 改 selection + 切 tab + 关抽屉。这就是「系统性关联」的可见形态。
  **实施(2026-10-26,Wave 3)**:第三段做成**内容**而不是「动作」——
  工件那一档的第三段是**正文现读**(那才是读者点「详情」要看的东西);
  关系 chip 本身就是地址,点它就是那个动作,不必另做一排按钮。
- ⚠️ **词表不许编关系**。`web/src/lib/artifactGraph.ts:16-29` 已经立过判据:第三类「逻辑关系」零写入侧 ⇒
  **如实报 0 条,不许用「同一时间窗内谁在谁之后」推边**。抽屉里同样成立:关系 chip 上写「0 条」,
  也不要把它渲染成「暂无」而让读者以为是加载失败(见 2.1)。

**判据:** `tests/web/relations.test.ts` —— ① 每种 `kind` 的每条 `rel` 都能在真夹具上解出 id;
② 目标不在本次加载集时**报出悬空**(与 `artifactGraph` 的 `dangling` 同一纪律),不静默丢;
③ 变异自检:让某条 `rel` 返回编造的 id ⇒ 红。

### 3.4 项目页降级为「仪表盘 + 钻取」

`web/src/routes/ProjectDetail.tsx` 现在**重复列**了工作项、提问、变更、阻塞 —— 与工作项页、成员页是
三份渲染、三份加载态、三份空态措辞。改成:**状态计数卡** + 「现在最要紧的一件事」+ 每条计数点了
**切 tab 并带上 selection**。

> 同一实体全站只有一种渲染方式,是「系统性」的硬前提。两处各渲染一遍的地方,**关联必然丢**:
> 你在 A 处点中它,B 处不知道。

**判据:** `tests/web/project-dashboard.test.ts` —— ① 项目页**不再**包含工作项列表行(负样本);
② 计数卡点击 ⇒ selection 被写入;③ `useProjectDetail(` 在四个文件里仍只出现**一次**(既有哨兵不许破坏)。

**实施(2026-10-26)**
- 新增 `web/src/lib/dashboard.ts`(**判据**,纯数据):`nextThing(facts)` ⇒ 七个档位之一 +
  判据 + 要不要你动作 + 地址;`countCards(facts, projectId)` ⇒ 六张计数卡。
- 新增 `web/src/components/dashboard/DashboardCards.tsx`(**排版**):计数卡是真 `<a href>`。
- 项目页**删掉「工作项」那一段**;工作项现在**只住在工作项页**。
  ⇒ 项目页在删掉清单之后**唯一**的「活儿」视图是**阻塞卡里的关系栏**(「它卡住的环节」)。
- ⚠️ **档位名带 `next_` 前缀** —— `orgState.ts` 的派生状态里已经有 `waiting_client` /
  `unreadable` 两个同名键(那是「组织运行态」那一套)。两套**不同的**状态机用同一批词
  ⇒ grep 一次出来两个意思 ⇒ 前缀把它们隔开。
- ⚠️ **数字读 `detail.counts`(服务端算好的)**,不许自己数一遍 —— 自己数会与左栏徽标漂开,
  而「两个地方显示不同的数字」是最难查的一类病。
- ⚠️ **读不到 ≠ 没事**:运行态读不到时第一档是 `next_unreadable`,**不是** `next_none`。
- ⚠️ **两条既有判据改了写法**(落点变了,判据没变,已在测试里写明):
  `acceptance-dock.test.ts` 的「待验收计数留着」从 `detail.counts.…` 改成认 `detail?.counts.…`;
  `annotation-budget.test.ts` 的 `work.status` 词汇条的读者从**项目页**搬到**工作项页**
  (工作项现在只住在工作项页)。
- 变异自检 `.probe/mutation-dashboard.py`(**10 条,全部实测变红**)。

### 3.5 两张图还是三张图

**保留两张**(分工是真问题):DAG 答「它们之间是什么关系」,时间泳道答「什么时候发生的」。
第三张(工作项 DAG)与第一张(工件 DAG)在**承诺上重叠**,建议**合成一张双类节点的图**:
节点 = 工作项 ∪ 工件,边类可切换,图例如实写 0 条的关系。**选中态与泳道共用 3.2。**

> **不做成「一张图 + 三个视图」** —— 那只是把复杂度藏起来,而本项目对「看起来能跑、其实在编」的代价
> 付得太多。

**判据:** `tests/web/work-graph.test.ts` 既有的边方向判据(先后:前置 → 本条;**子项 → 父项**)
与「同向不算环、反向才算环」(`mutualPairs`)必须原样通过 —— 合并**不许**放宽任何一条。

---

## 4. 不许动的线(动了会红,而且必须继续红)

| 不变式 | 钉住它的地方 |
|---|---|
| `useProjectDetail(` 在四个文件里只出现一次 | `tests/web/acceptance-dock.test.ts` |
| 交付物正文走 `<iframe sandbox="" srcDoc>`,**先 fetch 成文本**;禁止 `src=` | `tests/web/deliverable-render.test.ts`(剥注释后扫全 `web/src`) |
| `ROLE_LABEL` 与 `ORG` **逐字相等** | `tests/web/role-names.test.ts` |
| 「读不到」`runtime: "unavailable"` 不许渲染成「空闲 / 0」 | `ProjectLiveView` 三态 + 各消费点 |
| 图例的 0 条 / 反向边 / 悬空边如实报出 | `lib/artifactGraph.ts` 五条纪律 |
| 成员页三态(`读不到` / `正在读取…` / `共 N 条`)不许合并 | `AgentConversations` 的 `known` + `c10-dead-code.test.ts` |
| `grep -rn 'as any' src/ web/src/` = 0 | 编码纪律 |
| 基线 **2232 passed / 114 files** · 两条 typecheck · `check:design` E1–E14 | 每次交付 |

> ⚠️ 这一刀最容易造成的静默失败,恰恰是**把注释收干净的同时把「读不到」也收掉** ——
> 那会得到一个更好看、但会说假话的界面。因此 2.1 必须先于 2.2/2.3 落地。

---

## 5. 分波、验收、回滚

| 波 | 内容 | 判据 | 回滚 |
|---|---|---|---|
| **0** | 2.1 `DataState` → 2.2 `glossary`/`Help`/删 `hintTitle` → 2.3 预算哨兵 → 2.4 关于页 | 三个新测试文件全绿 + 既有 2232 条不变 | 单 PR,纯收窄;`DataState` 可保留而不接线 |
| **1** | 3.1 URL + 3.2 selection(**不加任何视觉**) | 往返恒等 + selection 三条 | 单 PR;`react-router` 未接管前 `useState` 仍是真相 |
| **2** | 3.3 Inspector + 3.4 项目页降级 | 关系/悬空/仪表盘三组 + 既有哨兵 | 项目页降级必须**在** Inspector 之后,否则删掉清单会真的丢信息 |
| **3** | 3.5 双类节点 DAG | `work-graph` 既有判据原样通过 | 最高风险;先看 0–2 的实际效果再决定做不做 |

**每一波的验收 = 四件事同时成立**:新测试带正负样本 + 变异实测变红;`npm test` 不低于 2232;
两条 typecheck 0 error;`check:design` 全绿。

**变异自检的纪律(复核过两次的教训):** 在语句**前面**加注释**不是**变异;`str.replace` 不匹配时
**静默不执行** ⇒ 每次变异必须断言「改后那一行确实变了」。「测试是绿的」在变异实测过之前不算数。

---

## 6. 明确不做的事

- **不做视觉重设计**(配色 / 字体 / 圆角 / 间距体系)——问题在信息架构,不在样式。
- **不做大爆炸重写** —— 114 个测试文件钉住的正是那些反造假不变量;重写会让它们以「看起来正常」的方式失效。
- **不动服务端** —— 不加端点、不加字段、不加迁移。若某一波**必须**要新字段,那一波就不是前端批次,
  应当单独立项并写清读面三态。
- **不把筛选挪到后端** —— 如 `client-questions` 的按项目显示,那是**显示口径**(`lib/questionScope.ts`),
  接口仍然一次给齐;顺手挪到后端会让「本项目有几件待答」这种问题无接口可问。
- **不在前端加常量** —— 错误码 / 平台通知前缀 / 角色名都已有唯一来源;多一张表就多一处漂移。

---

## 7. 还没定的(需要用户裁决,不是我能自己拍板的)

1. **信息顺序**:项目页降级成仪表盘之后,「现在最要紧的一件事」按什么排序(等甲方 / 被阻塞 / 失败)
   —— 这是产品判断,不是技术判断。
2. ~~**抽屉 vs 内联**~~ —— **已裁决(2026-10-26,Wave 3):抽屉**。
   理由不是「好看」,是**「关联」要求详情保持在场**(内联展开把图顶出屏幕,
   读者在图与详情之间来回滚,关联就断了)。实施见文末「Wave 3」一节。
3. **「关于这些数字」的入口**:顶栏 `?`、设置页一节、还是对话页右栏的一块。三种都可行,成本几乎一样。

---

## 8. 附录:131 处注释的逐条裁决(Wave 0 的工单)

**计数方法(可复现):** 单行属性扫描 `grep -o 'hint=\|hintTitle=\|<Disclosure\|ss-note'` 得 **131 处**引用;
按「一行一次命中」抽取得 **104 条**(多行 `hint={\`…\`}` 模板字面量不计入行级清单)。

| 类别 | 条数 | 处置 |
|---|---|---|
| `<Disclosure>` | 22 | **3 条保留**(`目标全文` / `原始字段` / 展开清单 = 内容容器,不是注解);其余 19 条进 §2.2 的 `glossary` |
| `className="ss-note"` | 40 | 逐条按下面三条红线判;预计 **≥ 26 条可删**(改由 `<DataState>` 的形态承载) |
| `hint=` | 23 | 留下的必须 ≤ 24 字(§2.3) |
| `hintTitle=` | 19 | **全部删除**,内容进 `glossary` / 关于页 |

### 8.1 `hintTitle` 19 条实测清单(共 **2465 字**的悬停正文)

| 位置 | 字数 | 实质 | 裁决 |
|---|---|---|---|
| `web/src/routes/Memory.tsx:248` | 203 | 三段数据的语义(画像/碎片 vs 语料) | → `glossary: memory.three-sections` |
| `web/src/routes/Memory.tsx:275` | 79 | **端点来源** | → 关于页 |
| `web/src/routes/ProjectDetail.tsx:186` | 52 | 端点来源 | → 关于页 |
| `web/src/routes/ProjectDetail.tsx:272` | 248 | 端点 + 分类器判据 | → `glossary: notice.stop` |
| `web/src/routes/ProjectDetail.tsx:343` | 217 | 端点 + 分类器判据 | → `glossary: notice.compliance` |
| `web/src/routes/ProjectDetail.tsx:385` | 107 | 分类器判据 | → `glossary: notice.other` |
| `web/src/routes/ProjectDetail.tsx:417` | 68 | 契约闭集取值 | → 关于页 |
| `web/src/routes/ProjectDetail.tsx:457` | 103 | 端点 + kind 判据 | → `glossary: client-question` |
| `web/src/routes/ProjectDetail.tsx:479` | 106 | 端点 + 契约 | → `glossary: ask` |
| `web/src/routes/ProjectDetail.tsx:552` | 125 | 端点 + 状态机 | → `glossary: change` |
| `web/src/routes/ProjectDetail.tsx:590` | 92 | 端点 + severity 闭集 | → `glossary: blocker` |
| `web/src/routes/Works.tsx:1407` | 36 | **交互说明**(点条/点节点) | **保留**,压到 ≤ 24 字 |
| `web/src/routes/Works.tsx:1521` | 141 | `workId` 为 null 是合法状态 | 句子留 24 字,余下 → `glossary: artifact.no-work` |
| `web/src/routes/Works.tsx:1568` | 44 | 悬空 `workId`(不是「没产出」) | 压到 ≤ 24 字 + `glossary: artifact.dangling` |
| `web/src/routes/Works.tsx:1748` | 220 | 推进图读法(横轴/上下区/联动) | 压到 ≤ 24 字 + `glossary: timeline` |
| `web/src/routes/Works.tsx:1821` | 194 | **页面级 provenance**(「本页 = …」) | → 关于页 |
| `web/src/routes/Members.tsx:1010` | 133 | 端点来源 | → 关于页 |
| `web/src/routes/Members.tsx:1022` | 133 | **与上行逐字相同** | 删(重复的同一段解释) |
| `web/src/routes/Members.tsx:1103` | 164 | 端点来源 | → 关于页 |

> **12 / 19 条是「数据来源:GET …」** —— 那不是注解,是**出处**。出处属于一张表(关于页),不属于 19 个悬停。
> `Members.tsx:1010` 与 `:1022` **逐字重复**同一段 133 字说明,是「同一句话被抄 N 遍」的直接证据:
> 抄的时候没人错,但将来改一处就漂一处,而没有任何检查会红。

### 8.2 三条红线:这些字**不能删**(它们不是注解,是判据)

1. `web/src/lib/orgState.ts:86-148` 的 `action` 文案(含「不需要你动作」「读不到不等于空闲」)——
   被 `tests/web/org-state.test.ts:110,148` **逐字钉住**。
2. `web/src/routes/ProjectDetail.tsx:361` 的「记录 · 不需要你动作」—— AGENTS.md 规定合规记录**只能说这一句**,
   任何「已解决」都是编造现场。
3. 「需要你处理 / 不用你处理」这一对(`ProjectDetail.tsx:456,478`)—— 它区分 `ClientQuestionView` 与 `AskView`,
   删掉就等于把「角色之间的事」重新塞回甲方队列。

### 8.3 因此 Wave 0 的实际范围(不是「全删」)

- **删**:`hintTitle`(`hintTitle` 实测是 **27 处**,不是 19 —— 见下面「实施记录」)
  + `Members.tsx` 里那段逐字重复 133 字 + `AcceptanceDock` 的一处 `title="来源:…"`。
- **换形态**:`ss-note` 里负责「读不到 / 还没查 / 真的是 0」的那些(≥ 26 条)→ `<DataState>`;
  **判据不变,承载方式变**。(**已实施四处 —— 见 §8.5;剩下的散点留在 Wave 1 顺手收**)
- **压缩**:`hint=` 里超 24 字的那 6 条 → **不改**(它们在 `CodeService.tsx`,全是技术事实)。
- **新增**:`lib/glossary.ts`(18 条)、`ui/Help.tsx`、`annotation-budget` 哨兵、
  `ui/DataState.tsx` 与「关于」页(**见 §8.5,已落地**)。
- **不动**:§8.2 三条红线、22 条 `Disclosure` 里的 3 条内容容器、任何服务端文件。

---

### 8.4 实施记录(2026-10-26,已落地)

```
web/src/lib/glossary.ts                 ← 新增:18 条(一句话 ≤ 24 字 + basis + source)
web/src/components/ui/Help.tsx          ← 新增:`?` 标记(button + 受控浮层)
web/src/components/ui/primitives.tsx    ← `hintTitle` prop **删掉**,换成 `helpId?: GlossaryId`
web/src/styles/globals.css              ← .ss-help / .ss-help-btn / .ss-help-body
web/src/routes/{ProjectDetail,Works,Members,Memory}.tsx   ← 27 处全部处置
web/src/components/members/RoleHarness.tsx               ← 2 处 + 删掉 267 字的 HARNESS_CARD_HINT
web/src/components/client/AcceptanceDock.tsx             ← 1 处 title="来源:…"
tests/web/annotation-budget.test.ts     ← 新增 11 条
```

**验证**:`grep -rn hintTitle web/src` = 0;`2243 passed / 115 files`;两条 typecheck 0 error;
`npm run build` 绿;`check:design` E1–E14 全绿。

**两个真实撞上的问题(都写进了代码注释)**

1. **`<details>` 不能拿来装 tooltip。** 第一版 `Help` 用原生 `<details>`(零状态),当场弄红
   **7 条已有判据**:`harness-by-role.test.ts`(6 条)与 `artifact-timeline.test.ts`(1 条)用
   「**第一个 `<details>` 之前**」切「卡片头」、用「这块里有没有 `<details>`」判「画布有没有默认收起」。
   ⇒ 这套代码里 `<details>` 的约定含义是「可折叠的**内容**」,借它装一个说明等于**伪造信号**。
   改成 `button` + 受控浮层后 **一条已有判据都没改** —— 「不要为了让测试变绿去改仪器」的正例。
2. **`hint` 的 24 字上限是错的。** `CodeService.tsx` 六条 30–74 字是全是要说的技术事实
   (「构建上下文不能是仓库根」「提交数按 `servicePath` 算」),一刀切会剔成噪音。
   保留它们,把判据换成「出处不许进 `hint`」。

⚠️ **统计口径的教训**:第一版写「19 条 2465 字」,那是用 `cut -c1-160` 截断看样本数出来的;
全量 `grep -c` 是 **27 处**。**截断过的样本看起来像全量,而它给出的数字没有一条断言会拆穿。**

**变异自检(实测变红)**:① 往 `Memory.tsx` 加回一条 `hintTitle=` ⇒ 判据 ① 红;
② 把一个 `hint` 改成另一处已存在的正文 ⇒ 判据 ④(不许抄两遍)红;
③ 摘掉 `helpId="harness.card"` ⇒ 判据 ⑤(条目没读者)红。每条都断言「改后文件确实变了」+ 还原校验。

---

### 8.5 实施记录 · Wave 0b(2026-10-26,已落地)

```
web/src/components/ui/DataState.tsx     ← 新增:四态判别联合 + remoteOf / remoteListOf
web/src/components/shell/AgentPanel.tsx ← 「详情」四态收进来
web/src/components/client/AcceptanceDock.tsx  ← 「待验收清单」四态收进来
web/src/components/client/ClientQuestionDock.tsx ← 「待答清单」四态收进来
web/src/routes/Members.tsx              ← 「成员」四态收进来
web/src/routes/About.tsx                ← 新增:四态说明 / 词汇表全表 / 已知不实之处
web/src/lib/glossary.ts                 ← 新增 `KnownGap` + `KNOWN_GAPS`(7 条,每条带落点)
web/src/App.tsx                         ← `Route` 加 `"about"` + 分支渲染
web/src/components/shell/TopBar.tsx     ← 导航末尾一个 `?`(TABS **仍然 6 项**)
tests/web/data-state.test.ts            ← 新增 14 条(两个构造器 + 四态两两不同)
tests/web/about-page.test.ts            ← 新增 12 条(逐条渲染 / 无空条目 / 不是第七个页签)
tests/web/question-scope.test.ts        ← 1 条改判:被渲染的仍是筛选结果(判据没变,落点从
                                           `items.map(` 换成 `remoteListOf(items,` + `rows.map(`)
.probe/mutation-wave0b.py               ← 6 条变异自检,全部实测变红
```

**验证**:`2269 passed / 117 files` · 两条 typecheck 0 error · `npm run build` 绿 ·
`check:design` E1–E14 全绿。

**四条判据(每条都有能变红的用例)**

1. **四态不许合一**:`RemoteState<T>` 是四处联合;`remoteListOf` 只在 `loading && rows.length === 0`
   时给 `loading`,查完的空数组才是 `ready` ⇒ 「空」只能在 `children` 里由调用点自己说。
2. **错误优先于数据**:`error !== null` 时哪怕有数据也走 `error`(M6 变异:吞掉 error ⇒ 红)。
3. **条目一条不落**:`GLOSSARY` 的键是闭合联合;**少渲染一条不会报错**,只是用户永远读不到
   ⇒ `about-page.test.ts` 逐条比对(M3 变异:`.slice(0, -1)` ⇒ 红)。
4. **「关于」不是第七个页签**:导航恒 6 项是 `AGENTS.md` 的既有判据;`TABS` 里出现 `about`
   当场红(M4 变异),只加 union 不接分支也红(M5 变异)。

**两个真实撞上的问题**

1. **`git checkout --` 复原不了未入库的新文件。** 第一版变异脚本用 `git checkout --` 还原,
   而 Wave 0b 的 `DataState.tsx` / `About.tsx` 还没 commit ⇒ `pathspec … did not match any file(s)`
   ⇒ **变异留在盘上**,脚本自己崩了。改成「按内存里的原文写回」+ 断言「复原后与原文逐字相同」。
   ⚠️ 教训与「`python str.replace` 不匹配静默不执行」同源:**复原这一步也需要断言**。
2. **一条变异抓不住任何东西时,先怀疑测试没覆盖,而不是代码没 bug。** M1(去掉「还没查过」那一档)
   最初指向 `acceptance-dock.test.ts`,结果全绿 —— 因为那个面板用的是 `remoteOf`,而那一行在
   `remoteListOf` 里。⇒ 补了 `tests/web/data-state.test.ts` 直接测两个构造器,M1 随即如实变红。
   **变异没被抓住有两种可能:判据无效,或者判据指错了地方。** 这次是后者。

### 8.6 实施记录 · Wave 1 第一步:地址承载 UI 状态(2026-10-26,已落地)

> Wave 1 有两半:**先有地址**,再有实体脊。这一节是前半 —— 它是后半的前置条件,
> 因为「一圈邻居」里的每一条边都得**指向一个可以被打开的地方**。

```
web/src/lib/route.ts        ← 新增:`Route` / `parseHash` / `toHash` / `paramOf` / `withParam`
                              / `toRoute` / `useAppLocation`
web/src/App.tsx             ← 页面读 `location.hash`;`export type { Route }` 只 re-export
                              (union 不再有第二份);`go(r)` 换掉 `setRoute`
web/src/routes/Members.tsx  ← 选中的成员 = 地址里的 `member`(`#/members?member=a_9`)
tests/web/app-route.test.ts ← 新增 16 条(解析 / 序列化 / 往返 / 坏地址 / 接线)
tests/web/about-page.test.ts← 1 条改判:判据没变,union 的落点从 App.tsx 换到 lib/route.ts
.probe/mutation-wave1.py    ← 6 条变异自检,全部实测变红
```

**语法**:`#/works?work=w_123` · `#/members?member=a_9` · 其余页签不带参数。

**四条判据**

1. **未知路由 ⇒ `chat`,并且丢弃陌生参数**(M1:保留参数 ⇒ 红)。地址是外来的(手打 / 旧收藏 / 别人贴的),
   白屏与「应用坏了」在屏幕上一样;而把 `?x=1` 留在别的页面上是另一种谎。
2. **同一份状态只有一个地址字符串**(M2:不排序 ⇒ 红)。键按字典序,空值不写进地址
   —— 否则「`member=` 空串」与「没选」会是两个地址,而它们语义相同。
3. **`chat` 故意不带 `project=`**。「当前项目」是跨页面的选择(对话 / 项目 / 工作项 / 成员 / 记忆都看它),
   钉在一条路由的查询串里会让「在工作项页换项目」丢状态。它是 store 的 `activeProjectId`。
4. **接线是可验的**:`App` 不再有 `useState<Route>`(M4)、成员选中项不再有私有 state(M5)
   —— 一个没人调用的 `lib/route.ts` 与「它能用」在界面上完全一样。

**两个真实撞上的问题**

1. **`noUncheckedIndexedAccess` 下 `params[key]` 是 `string | undefined`**,不是 `string`。
   第一版 `Object.keys(...).map(k => loc.params[k])` 与 `hasOwnProperty ? loc.params[key] : null`
   两条都过不了 typecheck ⇒ 改成 `Object.entries` 与显式 `undefined` 判定。
   ⚠️ 这不是「加个 `!`」的问题:`JSON.parse` 出来的对象上,**「键存在但值是 undefined」是可能的**。
2. **改判要写清「判据没变、落点变了」**。`about-page.test.ts` 那条断言的是「`about` 是一条真路由」,
   它原来 grep `App.tsx` 里的 `| "about"` —— union 搬家后它红了,**而它要守的东西一条没变**。
   ⇒ 改成 `source("lib/route.ts")` 仍断言同一件事,并在测试里写明为什么换落点。

**下一步(Wave 1 后半)**:`Works` 的 `work=` / `Artifact` 的 `artifact=` 同样搬进地址,
然后每个实体一张 `MetadataStrip` —— 目标是「同一个工件在四处各说一套」变成「一个地址,一圈邻居」。

**补记(同日,第二步落地)**:`Works` 的两个交互态也搬进了地址 ——
`#/works?work=w_1&artifact=a_2`(`picked` 三态里的 `null` 被有意收窄:界面里没有
「取消选中」这个动作,而地址只有两态,留着它只会让「它该不该进地址」变成没有答案的问题)。
`tests/web/app-route.test.ts` 16 → 17 条,`.probe/mutation-wave1.py` 6 → 7 条变异。
**验证**:`2286 passed / 118 files`。

### 8.7 实施记录 · Wave 1 第二步:实体脊(2026-10-26,已落地)

**目标**:`§3.3` 的那句话 ——「同一个工件在四处各说一套」变成「**一个地址,一圈邻居**」。

**两份新文件,职责严格分开**

| 文件 | 职责 | 不许长成什么 |
|---|---|---|
| `web/src/lib/entityMeta.ts` | **判据**:一份输入 ⇒ 一组事实(标签 / 值 / 邻居地址) | 一个 React 组件(它不 import React,纯数据 ⇒ 可在测试里直接断言) |
| `web/src/components/ui/MetadataStrip.tsx` | **排版**:把事实渲染成一条带子 | 第二个事实来源(它不许自己决定「作者是谁」) |

**事实长什么样**

```ts
type MetaItem = {
  label: string;                              // 标签 = 对外的词表
  value?: string;                             // 没有链接时的文本
  title?: string;                             // 为什么这么算(判定依据)
  links?: { label: string; to: RouteTarget }[]; // 邻居 = 真地址
};
```

三个构造器:`artifactMeta(a, opts?)` · `workMeta(w)` · `blockerMeta(b, titles?)`,
外加三个地址构造器:`memberLocation(agentId)` · `workLocation(workId)` · `artifactLocation(artifactId, workId?)`。

**三条设计判据**

1. **标签是契约** —— 同一类实体在任何地方用**同一个词**。
   「作者」不写成「产出者」,「产出于」不写成「来自」,「登记」不写成「创建」。
   ⇒ `tests/web/entity-meta.test.ts` 把三个标签数组**逐字快照**下来(M4 改一个词就红)。
2. **邻居必须有地址** —— 「作者」「产出于」「父项」「卡住」这几格指向**真的地址**,
   不是拼出来的字符串:拼错了会指向别的东西,而**拼错与拼对在屏幕上长得一样**。
   ⇒ 地址由 `lib/route.ts` 的 `toHash` 序列化,测试断言的是 **href 逐字相等**。
3. **拿不到就明说,不留空** —— 标题读不到退成 `id`;工件不由任何环节产出 ⇒
   「不由工作项产出」;顶层环节 ⇒ 「顶层环节」;阻塞没登记卡住谁 ⇒ 「没有登记卡住的工作项」(**不是 "0"**)。
   ⇒ 空与「没有」在屏幕上一样,这是 AGENTS.md 里反复出现的那条纪律。

**接线(三处,不多不少)**

- `Works.tsx` —— 工件节点标题旁一条带子;**图节点的悬浮提示也改用同一份格式化**
  (`authorLabelOf()`):一处 tooltip 自己写 `authorName || authorAgentId` 就是**多了一个事实来源**。
- `ProjectDetail.tsx` —— 工作项卡一条带子;阻塞卡一条带子(「卡住」那格是**数出来的**:`2 个工作项` + 每条一个地址)。
- `Members.tsx` —— 成员面板里的工件列表:标题变成地址,下面一条带子。

**防腐坏的哨兵**(`tests/web/entity-spine-wiring.test.ts`,源码级)

- ① `authorName ||` / `assigneeName ||` / `raisedByName` **只允许出现在 `lib/entityMeta.ts`**
  —— ⚠️ 挑「带兜底的写法」而不是字段名本身:字段名在**原始字段区块**与 SVG `title=` 提示里**本来就该出现**,
  那两处是「原始坐标」不是「身份的说法」,禁掉它们会逼着人把原始字段藏起来,那比重复更糟。
- ② 三个页面都用了 `<MetadataStrip`。
- ③ **每一处 `<MetadataStrip items={…}` 的内容都来自 `entityMeta` 的构造器** ——
  不许手写 `items={[{ label: "作者", … }]}`(M7 变红)。
- ④ 页面**不许手拼地址**(`"#/members?member="` / `"#/works?work="` 一律不许出现在页面里)。

**变异自检**:`.probe/mutation-entity-spine.py` **8 条全部实测变红**
(M1 地址拼错 · M2 标题退成空 · M3 条数写死 · M4 换标签 · M5 谎称有父项 ·
M6 `<a href>` 改成 `onClick` · M7 页面自己造事实 · M8 页面自己兜底作者名)。

⚠️ **M6 值得单说**:链接如果用 `onClick` 改 hash,「右键复制地址 / 中键开新标签 / 浏览器后退」三件全消失,
**而页面看起来一模一样**。所以身份带的链接必须是真 `<a href>`。

**验证**:`2311 passed / 121 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

**还没做的(Wave 1 后半剩余)**:「项目页降级为仪表盘 + 钻取」(`§3.4`)·
`RelationsRail`「一圈邻居」的**可视化**(`§3.2` 已有地址,还没有一圈邻居的图形)·
`§7` 里那三条待裁决(项目页「最要紧一件事」怎么排 / 工件详情走抽屉还是内联 / 「关于」放哪)。

---

### 8.8 实施记录 · Wave 1 第三步:「一圈邻居」(`§3.2` 的可视化)(2026-10-26,已落地)

**目标**:`§3.2` 的那句话 ——「**它连着什么**」也要有**一份判据**。
改版前这一面**三处各写各的,而且没有一处能点**:

| 原来在哪儿 | 原来长什么样 | 毛病 |
|---|---|---|
| 工件卡片 | `关联 parent→art_x` | **原始 id + 英文关系词**;读者既看不懂也不知道点哪儿 |
| 工件详情 | 一节「关联(N)」 | 标题能读懂,但**不是链接**(跳不过去) |
| 工作项面板 | 「前置」纯文本一串标题 | 同样跳不过去 |
| 成员面板 | **没有这一面** | 「他手上有哪些活」(含已完成的)别处也查不到 |

**两份新文件,职责与 `entityMeta` / `MetadataStrip` 严格同构**

| 文件 | 职责 | 不许长成什么 |
|---|---|---|
| `web/src/lib/relations.ts` | **判据**:`relationsOf(主体, 上下文) ⇒ 一组关系组` | 一个 React 组件(不 import React ⇒ 测试直接比对输出) |
| `web/src/components/relations/RelationsRail.tsx` | **排版**:把关系组渲染成一条带子 | 第二个事实来源(它不许自己决定「前置」叫什么) |

**分工:身份条 vs 关系栏(两者的关系类**互斥**)**

| | 身份条(`entityMeta`) | 关系栏(`relations`) |
|---|---|---|
| 答 | 这是什么 | 它连着什么 |
| 拥有 | 作者 / 产出于 / 负责人 / 父项 | 相关工件 / 子项 / 前置 / 阻塞 / 负责的环节 |

⚠️ **互斥是判据**(`tests/web/relations.test.ts` 有一条断言两边不许出现同一个词)——
同一个事实两处说 = 读者没法把两处的话对上,那正是这次重构要治的病。

**四条判据**

1. **「没有」与「读不到」分开** —— 组有三种状态:
   `ready`(算出来了,**可能 0 条**,那是「没有」这个事实)· `loading`(还在拉)· `unavailable`(拉失败/没接这份数据)。
   ⚠️ **后两者都不是「没有」** —— 这与 `DataState` 的四态、`ProjectLiveView.runtime = "unavailable"`
   是同一条纪律。上下文里**没接**的那份数据(比如这一页没取阻塞列表)⇒ `unavailable`,
   **不是**「空」。
2. **地址是地址本身** —— 每一项都是真 `<a href>`(右键复制 / 中键 / 后退三件全靠它),
   且**阻塞的地址必须带项目 id**(`blockerLocation(b.id, projectId)`):
   阻塞只存在于**某一个**项目里,而「当前项目」是应用里的一处**全局选择** ——
   不带项目 id 的地址是**半个地址**(只在「你正好在看那个项目」时成立,而链接的用处恰恰是从别处跳过来)。
3. **拿不到就退成 id,不留空** —— 目标不在本次列表里 ⇒ 退成 `art_9`。
4. **不适用的组整组不出现**(那是事实,不是故障)—— 例如不由任何环节产出的工件,**没有**「它所属环节的阻塞」这一组。

**顺带修掉的两个真 bug**

- **`?blocker=` 与 `?project=` 曾经是「指向空气的地址」**:参数写进地址,但**没有任何页面读它**
  ⇒ 点得动、跳得过去,落点没有那条阻塞。`ProjectDetail.tsx` 现在真的认这两个参数(定位 + 高亮 + 深链接切项目)。
- **深链接一打开就被抹掉**:`WorksPage` 挂载时跑一遍 `setPicked(undefined)` ⇒
  `#/works?work=w_1` **落地时选中项已经没了**。症状是「页面就是没选中」——
  看着像用户自己点错了,不像 bug。判据现在在 `lib/route.ts` 的 `shouldClearSelection`(可单测):
  **首帧不清**(深链接是这一整层改动的目的)、**项目没变也不清**。

**顺带收掉的一个「两个真相」**:工作项页原来有一个**页面私有**的 `scope` 下拉,
而左栏 / 对话 / 项目 / 成员页用的是 store 的「当前项目」⇒ **同一个应用里两个「当前项目」**。
两处一旦不同,**从这里发出的链接就落在别的项目里**(「点这条前置 → 跳过去却不是那条前置」),
而读者看不出为什么 —— 链接没坏,是**上下文**换了。⇒ 现在只有 store 那一个。

**接线(三处)**

- `Works.tsx` —— 工件行上**紧凑**关系栏(只说「相关工件」);工件详情里**完整**关系栏
  (含「它所属环节的阻塞」—— 这一格以前要跳到项目页才看得见);工作项面板里**完整**关系栏
  (「子项 / 前置 / 卡住它的阻塞」—— 原来的「前置」纯文本随之删除,关系**只住一处**)。
- `ProjectDetail.tsx` —— 工作项卡上**紧凑**关系栏(子项 / 阻塞);阻塞卡认 `?blocker=` 高亮定位。
- `Members.tsx` —— 成员面板新增一节「**他负责的环节**」(此前不存在这一面)。

**测试**:`tests/web/relations.test.ts`(23 条:判据 + 排版)· `tests/web/relations-wiring.test.ts`(12 条:源码级接线)。

**变异自检**:`.probe/mutation-relations.py` **12 条全部实测变红**
(M1 「读不到」说成「没有」· M2 loading 档消失 · M3 关系词退成英文原值 ·
M4 阻塞地址丢项目 id · M5 `<a href>` 改 `onClick` · M6 「读不到」显示成「无」·
M7 关系组名与身份条重叠 · M8 深链接首帧被清 · M9 换项目不清旧选择 ·
M10 页面私有 scope 复活 · M11 项目页的关系栏消失 · M12 成员页的关系栏消失)。

⚠️ **M11 / M12 是「没有读者」那一课的续集** —— 判据写得再好看,
**页面上没有 `<RelationsRail` 就是零读者**。所以接线也必须有哨兵钉住。

**验证**:`2346 passed / 123 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

**还没做的**:`§3.5`(两张图还是三张图)· `§7` 三条待裁决。

---

## 2026-10-26 · §3.4 项目页降级为仪表盘(已落地)

**交付**:`web/src/lib/dashboard.ts`(判据)· `web/src/components/dashboard/DashboardCards.tsx`(排版)·
`tests/web/project-dashboard.test.ts`(20 条)· `.probe/mutation-dashboard.py`(10 条,全部实测变红)。

**基线**:`2366 passed / 124 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

**三条新教训(#lesson)**
1. **档位名会撞车** —— `orgState.ts` 的派生状态里已经有 `waiting_client` / `unreadable`,
   而仪表盘的档位也想叫这两个名字。⇒ 两套**不同的**状态机用同一批词,
   grep 一次出来两个意思 ⇒ **加 `next_` 前缀**隔开。
2. **改判要写清「判据没变、落点变了」** —— `acceptance-dock.test.ts` 那条
   「待验收计数留着」原来 grep `detail.counts.pendingAcceptance`,
   落点搬到仪表盘后写法变成 `detail?.counts.…`(因为 `useMemo` 跑在空值守卫之前)。
   ⇒ 判据改成正则认两种写法,并在测试里写明**为什么改**。
3. **词汇表条目会因「搬走一整段」变成孤儿** —— `work.status` 那条 `?` 的读者
   原本在项目页的「工作项」段;删掉那一段后它**没人读了**(7-E 的复发)。
   ⇒ 读者搬到**工作项页**(工作项现在只住在那儿),而不是删条目。

---

## 2026-10-26 · Wave 2b:注解预算收口(已落地)

**起点**:Wave 0a 把 `hintTitle=` 从 `primitives.tsx` 删掉了,但同类的东西从两个缝里长回来了:

| 缝 | 实测(2026-10-26,剥注释后 `grep -c`) | 后果 |
|---|---|---|
| `hint=` 重新长到 **25 处** | `Works.tsx` 把**动作说明**写进悬停(「点一条工作项(绿色条)⇒ …」);`CodeService.tsx` 一行 74 字;`Memory.tsx` 两条解释的是**布局** | 触屏不触发、不可复制的灰字 |
| 屏上出现**裸 `**`** | **35 行**(9 个 `.tsx` + `lib/` 里 3 个 `.ts` 的字符串常量) | JSX 不渲染 markdown 粗体 ⇒ 用户读到「**读不到**这份正文」,**带两个星号** |

**处置**

- **`hint` 逐文件记账,只许减不许增**:`hint=` 从 25 → **14**;每文件预算 = 现值
  (`CodeService.tsx` 5 是技术事实例外、`ProjectDetail` 3、`Members` 2、`Works` 2、
  `RoleHarness` 1、`About` 1)。用「全局默认 + 例外」是不够的 —— 那样 `Works` 从 2 涨到 3
  不会红,而**慢慢长回来**正是要拦的那件事。
- **`hint` 一行话 ≤ 40 字**(`CodeService` 例外):`CodeService.tsx` 的「交付版本 vs HEAD」
  那段原先是**三处同一件事**(两行悬停 + 一段正文)⇒ 悬停各留自己那一行独有的事实,关系留在正文。
  删掉的:`分层排布,可能较宽` / `点条选中,再点取消` / `已在图上(按 kind 落在自己那一行)` /
  `结构化摘要 · 与碎片互补` / `流水式记录` / `页面上作过多解释` 的 `关于` 页副标题等。
- **裸 `**` 全部清掉**(35 行):它们不是「注释过多」,是**屏幕上多出的字符**。

**判据(4 条,`tests/web/annotation-budget.test.ts` 15 条)**:⑥ `hint=` 总量与逐文件预算 ·
⑦ `hint` 长度 · ⑧ 剥注释后不许有裸 `**`(唯一例外:`lib/ws.ts` 的幂运算符 `2 ** n`)·
⑨ 长悬停(`title="…"` > 40 字)**只许减不许增**(现值 33 条 / 总 103 条)。

**变异自检**:`.probe/mutation-wave2b.py` **4 条全部实测变红** ——
第一次 ⑥ 那条**是绿的**,原因不是测试坏了,而是**变异太弱**(预算 3 允许 Works 2→3)。
⇒ 记一条:`变异自检绿了` 有两种可能 —— 判据没生效,**或者改得不够坏**。两者必须分开查。

**一条必须记住的教训(#lesson)**:清理裸 `**` 时我用脚本**整篇替换 `**` → 空串**,
把 `web/src/lib/ws.ts` 里 `Math.min(1000 * 2 ** this.reconnectAttempts, 8000)` 的
**幂运算符**也删了 ⇒ 语法错误,而它长得像一次成功的机械清理(退出码 0、35 行都「处理了」)。
⇒ **批量正则清理必须先算清「这个词在这门语言里还有别的含义」**,并且让脚本把每一处改动
**打出来**(事后是 `git diff` 抓到的那一处,不是脚本自己发现的)。

**基线**:`2370 passed / 124 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

**还没做的**:33 条 >40 字的长悬停是**这一波没还的债**(它们要逐条判断「是概念(→ 词汇表)
还是一次性事实(→ 留在悬停但压短)」,会撞 `harness-by-role` / `artifact-timeline` 的既有判据)。

---

## 2026-10-26 · Wave 2c:长悬停还债(已落地)

**债的来源**:Wave 0a 想除掉「整段正文藏进悬停」,但只封死了 `hintTitle` 这一个 prop。
实测(`title="…"`,剥注释后):**103 条**,其中 **33 条 > 40 字** —— 一条 142 字的卡片头口径摘要、
125 字的 `readyWorks = …` 定义、94 字的工作目录说明……**那不是悬停,那是正文被换了容器。**

**处置**:33 条逐条压到 ≤ 40 字。**留歧义消解,砍机制细节** —— 一条悬停要回答的是
「这个数/这格是什么意思」,不是「它由哪几道门控算出来」。逐条例子:

| 原来(字) | 现在(字) |
|---|---|
| `readyWorks = 派给他、前置已满足、还没终态的活;waitingWorks = …;exhaustedTodos = 尝试预算用尽、排空器不再叫醒的待办数(静默放弃是禁止的,所以它必须显示)。` (125) | `ready 前置已满足 · waiting 还没 · exhausted 不再叫醒` (40) |
| `卡片头状态摘要:单元 = …;能力 = …;实得工具 = …;集合文件 = …` (142) | `口径见展开后的各节 · 工具数不是能力的分数` (24) |
| `这一份快照的 runtime = unavailable:该进程没接上运行期快照(例如只挂 HTTP 的装配)。⚠️「读不到」与「它真的停着」是两件事 —— 所以这一格不下任何关于回合的结论。…` (125) | `读不到运行态,不是「它停着」· 库里的活照常显示` (24) |
| `GET /api/projects/:id/live 失败。WS 断了 REST 还在,所以这一条会自己重试(2.5s 一次)。` (64) | `运行态读面失败 · 会自己重试(2.5s 一次)` (24) |

**判据**:第 ⑨ 条从「ratchet(不许再长)」升级成「**一条都不许有**」:
`title="…"` 逐条 ≤ 40 字,条数 ≤ 103(总数仍是 ratchet:103 条里多数是画布节点的短标签)。
⇒ 现在实测:**> 40 字 0 条,最长 40 字**。

**顺带修掉一处「悬停与正文重复」**:`AgentConversations.tsx` 那条悬停原先把**屏上那句**
(`进行中的内容只在它正在跑的时候看得见…`)又抄了一遍,后面才跟诊断。⇒ 悬停现在**只留诊断**
(`这里空着多半是实时连接断了 · 已完成的不受影响`),屏上那句只留一次。

**⚠️ 压短时保住的红线**(这三条不是「长一点没关系」,它们是**诚实**):
- `读不到运行态,不是「它停着」` —— 压成「运行态读不到」就变成了「没在跑」;
- `不是「0 个工具」` —— 压掉这句,「组织还没播种」会读成「这个角色没有工具」;
- `不是分数关系` —— 压掉这句,能力 37 / 工具 48 会被读成「少了 11 个」。

**变异自检**:`.probe/mutation-wave2b.py` 的第 ④ 条改成「把一条悬停加长到 47 字」,实测变红。

**基线**:`2370 passed / 124 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

---

## 2026-10-26 · Wave 2d:判据搬回来看得见的地方(已落地)

**问题**:Wave 2c 把 33 条长悬停逐条压到 ≤ 40 字 ⇒ **解释没有消失,只是被压扁了**。
而压扁的代价是:「这个数由哪几道门控算出来」「这个 `runtime=unavailable` 为什么不是「它停着」」
这类**判据**从此没有落点了 —— 悬停只留了「这个数是什么意思」。

**处置**:被压掉的**判据**搬进 `lib/glossary.ts`,由**点得开的 `?`** 呈现(`ui/Help.tsx`):
触屏可用、可复制、常显,不像悬停那样「理论存在、实际没人读完」。

**词汇表 18 → 29 条**,新增 11 条,每条都**有读者**(判据:每条至少一个 `?` 在用它):

| id | 一行话 | 读者落在 |
|---|---|---|
| `member.runtime` | 在跑 ≠ 欠着活,两回事 | 成员页「运行态读不到」那行 |
| `agent.busy` | 在跑是内存忙闩,不是工作项状态 | 成员面板「手上的活」 |
| `member.todos` | 待办三种:能跑 / 还没 / 不再叫醒 | 成员面板待办那一行 |
| `member.conversations` | 他说了什么:只读的对话全文 | 成员面板「他说了什么」 |
| `artifact.body-index` | 库不存正文,只记落点 | 工作项页「原始字段」里正文落点那行 |
| `artifact.drift` | 索引漂移:正文被手改过 | 交付物正文上方那行漂移提示 |
| `work.artifacts` | 这条环节上的产出件数 | 工作项页「它挂着的工件(N)」 |
| `harness.gates` | 三道门,只减不增 | 角色 harness 卡「实得工具」 |
| `client-question.closed` | 已收口项目的提问,不再等 | 「待答」面板底部那行 |
| `settings.workdir` | 命令与文件都从这里出发 | 设置页「工作目录」 |
| `code-service.ignored` | 被 gitignore 吃掉的文件 | 代码服务交付物那行告警 |

### 两条判据变了形状(判据本身没变)

1. **读者有两种写法**,扫描器必须**两种都看得见**:
   `helpId="x"`(`Section` / `PageHeader` 的 prop)与 `<Help id="x" />`(正文里直接嵌)。
   ⚠️ 只认前者时,后者的条目会被报成「声明了没人用」—— 而「没人用」这个结论
   **会让人把真的读者删掉**(那是一条**自信的假话**)。⇒ 扫描器同时认两种,
   并加一条**自检**:两种写法**各至少有一个**读者(否则又是一次「仪器只看一处」)。
2. **`deliverable-render.test.ts` 的「没有一处读 `artifact.body`」**:
   正则加了 `(?!-)`。**判据没变**(仍然禁止读那个字段),变的是它能匹配的形状 ——
   原来的 `/\bartifact\.body\b/` 把**词汇表条目 id** `artifact.body-index` 也匹配上了
   (`body` 后面是 `-`,`-` 是非词字符 ⇒ `\b` 成立)⇒ 一条注释 id 被当成了字段读取。
   ⚠️ **仪器比判据宽**,而宽出来的那个匹配**会让人改代码**(去改 id 或删读者),而不是修仪器。
   ⇒ 加了**负样本自检**:`artifact.body-index` 不该被匹配,`artifact.body.length` 仍被匹配。

### 两条新教训(#lesson)

1. **变异脚本的 runner 也会「只看一处」**:M5 的判据在 `deliverable-render.test.ts`,
   而脚本只跑 `annotation-budget.test.ts` ⇒ 变异「改坏了却是绿的」。
   ⇒ runner 必须覆盖**本波所有判据所在的文件**;**变异脚本自己也会犯仪器只看一处的错**。
2. **「读者有两种写法」这件事本身要有判据**:词汇表里「每条都有读者」那条断言,
   只认一种写法时,另一种写法的条目全是**假孤儿**。

**变异自检**:`.probe/mutation-wave2d.py` **5 条全部实测变红**
(M1 删一个 `?` · M2 扫描器只认一种写法 · M3 塞一条没读者的条目 · M4 清空判据落点 ·
M5 真读一次 `artifact.body` ⇒ 「正文走现读」必须变红)。

**基线**:`2370 passed / 124 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

## 2026-10-26 · Wave 2e:跨项目地址带坐标 + 语料来源有地址(已落地)

### 为什么是这一刀

勘查六个页面之后,「信息不能系统性关联」只剩**一处**真的不成立:
**记忆页「知识语料」段的每一行,它的来源是纯文本**(`工件` / `消息` / 一串 id),
点不动。其余页面的条目都已经是真 `<a href>`。

而这件事之所以没被前几波修掉,是因为它暴露了一个**更底层的问题**:
**跨项目的地址没有坐标**。

### 一、`?project=` 是**坐标**,不是状态

这个应用里的实体大半是**项目级**的(工件、工作项、成员、阻塞、语料块),
而「当前项目」是应用里的一处**全局选择**(store 的 `projectId`)。
⇒ 指向别的项目的地址必须带 `?project=`,否则它是**半个地址**:
「点得动、跳得过去、就是找不到」,而链接**看起来完全正常**。

三条纪律:

1. **坐标,不是状态** —— 它回答「这条地址说的是哪个项目」,
   **不**回答「你现在在看哪个项目」。⇒ 它不会跟着导航自动出现,
   也不该在每个地址里都躺着。
2. **落地时生效** —— 读到它与当前项目不同,就切到那个项目。
3. **坐标会过期** —— 用户随后自己切了项目,坐标就指错了地方 ⇒ **清掉它**。

### 二、⚠️ 改版前有一份自己的 `?project=` 效果,而它是**坏的**

`routes/ProjectDetail.tsx` 里原来有一个效果:每次渲染都看地址里的项目,
不等当前项目就切过去。⇒ **用户从左栏切了项目**(地址没变)⇒ 那个效果又把他拽回去
⇒ 「切项目」这个动作被撤销,症状是「点左栏没反应」。

⇒ 现在这件事**只有一处**做:`web/src/lib/deepLink.ts`
(`decideCoordinate` 纯函数 + `useProjectCoordinate` 薄壳,`App.tsx` 挂**一次**)。
三条走法:

| 现场 | 动作 |
|---|---|
| 地址点名了另一个项目 | 切过去,并记下「这个坐标用过了」 |
| 已经在看它 | 什么都不做(但记下坐标用过了) |
| 项目被别人改了(不是我们改的) | **清掉地址里的坐标**(它过期了) |

⚠️ **「坐标过期就清掉」这一步是关键** —— 不清的话,下一次任何导航
(哪怕那个导航保留了 `?project=`)都会把用户拽回上一个项目,
症状是「切了项目又跳回去」。

⚠️ **指向空气的地址不切** —— 地址点名的项目不在已知列表里 ⇒ 不切
(切过去只会得到一个空项目,而症状是「应用坏了」);
但**列表还没读到时照切**(列表没到 ≠ 项目不存在)。

### 三、⚠️ 坐标带来的换项目**不许抹掉选中项**

工作项页有一条「换项目 ⇒ 清掉地址里的 `?work=` / `?artifact=`」的规则。
深链接长这样:`#/works?work=w_1&project=p_2` —— **坐标**把应用带到 p_2,
而 `?work=w_1` **本来就是给 p_2 写的**。照「项目变了就清」处理,
深链接落地后选中项会被自己抹掉 —— **症状是「点得动、跳得过去、就是没选中」**,
而这正是这一层改动**要修的那个 bug** 换个方向又犯一次。

⇒ `shouldClearSelection(state, nextProjectId, addressProjectId?)` 加了第三格:
**地址带来的换项目 ⇒ 不清**。

### 四、语料来源有地址

`lib/entityMeta.ts` 加两个事实构造器:`chunkSourceLabel`(叫什么)与
`chunkSourceLocation`(在哪)—— **标签与地址同源**,不许各说各的。

| 来源 | 地址 |
|---|---|
| 工件 | `#/works?artifact=art_7&project=p_2` |
| 消息 | `#/chat?project=p_2` |

⚠️ **拿不到项目 ⇒ 不编地址** —— 半个地址比没有地址更坏。
⚠️ **消息来源落不到那一句** —— 地址这一层还没有「定位到某条消息」的参数
(对话页只有项目与线两个层级)⇒ 落到那个项目的对话页。这个缺口**如实记着**,
不假装「点进去就能看到那句话」。

### 判据与回归

- `tests/web/deep-link.test.ts`(26 条):判据(纯函数五条走法 + 负样本)、
  决策(三条走法)、接线(只有一处判据 / 页面不再自己切 / 坐标过期就清)、
  地址(逐字比对 href)、深链接落地(坐标带来的换项目不清选中项)。
- `tests/web/relations-wiring.test.ts`:一条断言的**落点变了**
  (`?project=` 从项目页搬到 `lib/deepLink.ts`),判据没变;另一条断言因为
  守卫多了一个参数而改成**不写收尾右括号**的前缀匹配。
- 变异自检 `.probe/mutation-wave2e.py` **8 条全部实测变红**。

**基线**:`2392 passed / 125 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。

## 2026-10-26 · Wave 3:工件详情搬进右侧抽屉(已落地)

### 为什么是这一刀

§7 第 2 条一直挂着:「工件详情是右侧抽屉还是仍留在页面下方」。
裁决:**抽屉** —— 理由不是「好看」,是**「关联」这件事要求详情保持在场**:
内联展开会把下面的清单顶走、图顶出屏幕,读者在「看图」与「看详情」之间来回滚,
**关联就断了**(而这一整层改动的目的就是让关联可见)。

### 三段结构

`components/shell/EntityInspector.tsx` = **排版**:三段(事实 / 关系 / 内容)。

| 段 | 内容 | 判据来自 |
|---|---|---|
| 事实 | `MetadataStrip` | `lib/entityMeta.ts` 的构造器(调用点给 `items`) |
| 关系 | `RelationsRail` | `lib/relations.ts` |
| 内容 | 调用点给(`children`) | 工件的正文现读 |

⚠️ **抽屉不许自己算事实、不许自己拼地址** —— 它是新的渲染面,
而「同一实体全站只有一种渲染方式」是这一层的硬前提。
⇒ 源码级哨兵:抽屉文件里不许出现 `fmtTime(` / `artifactKindLabel(` /
`workStatusLabel(` / `blockerStatusLabel(` / `toHash(` / `href=`
(⚠️ **扫描前先剥注释** —— 判据那句话本身写在抽屉的注释里,
不剥就等于**判据把自己判红了**)。

### 接线

- 工件详情**只住在抽屉里**:行里不再内联展开(否则同一实体两个渲染面)。
- 开关**仍然是地址里的 `artifact=`** ⇒ 深链接照旧成立。
- 拿不到那份工件时(深链接指向不在本次列表里的工件)⇒ **事实段与关系段整段不出现**,
  不是「一段空的」。

### 判据与回归

- `tests/web/entity-inspector.test.ts`(11 条):三段各归各位 ·
  拿不到的那一段整段不出现 · 源码级(不许自己算事实 / 拼地址 / 三条关法) ·
  接线(只住在抽屉里 + 开关是地址)。每条源码级判据都带**正样本自检**。
- 变异自检 `.probe/mutation-inspector.py` **6 条全部实测变红**。
  ⚠️ **M1 第一版是「语法错红」**:注入点放在 `{items.length > 0 && (` 后面
  造成两个并列元素 ⇒ JSX 解析失败 ⇒ 测试红,但**不是**因为那条断言。
  ⇒ 变异必须**能编译**,否则「红」证明不了任何事(与「加个注释不算变异」同款)。

**基线**:`2407 passed / 126 files` · 两条 typecheck 0 error · build 绿 · `check:design` E1–E14 绿。
