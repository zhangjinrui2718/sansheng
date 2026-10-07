# 工作区设计 · 每项目一仓 + 工件索引化

> **状态:已定稿,一次性交付(实施中)。** 2026-10-08。
> 依据:用户六条输入(2026-10-08)+ 本文下附的本机实测证据。
> 与代码冲突时**以代码为准** —— 本文是意图,实施后要把不符处改掉(三份既有设计文档的前车之鉴)。

---

## 0. 六条输入

| # | 用户原话 | 本文处置 |
|---|---|---|
| 1 | 按每个项目来构建文件系统的管理,每个 agent 的产出、临时文件都放在这个目录里 | §2 |
| 2 | 不需要任何归档动作,用 git 管这个目录,所有 agent 的产出都 commit 进来 | §3 |
| 3 | 数据库里不要存真实内容,存一个索引就好了 | §4 |
| 4 | `code_service` 不冲突,直接复用当前项目的 git 仓库 | §3.2 |
| 5 | 交付口径选第一种 | §7:交付物 = `services/<name>/`,整仓对甲方可见(透明交付) |
| 6 | **老的数据可以完全不要,一会就要重置 sansheng** ⇒ 不考虑数据迁移,直接一步到位 | §5:一次 schema 变更到终态。**没有混合期、没有回填脚本、没有目录归位** |

第 6 条把原方案的分期整个消掉了:原 P0–P3 的存在理由是「任何时刻系统都自洽,不需要一次性 cutover」;
存量数据一旦不要,那个理由就不成立,直接做终态更简单、fail 面更小。

---

## 1. 现状(实测,不是印象)

| 事实 | 值 | 出处 |
|---|---|---|
| 工作根 | `/Users/fuyao/sansheng-workspace`(settings.json 的 `cwd`) | `src/platform/host/serve.ts:388` |
| 5 个角色的会话 cwd | **同一个值** | `serve.ts:901` |
| 项目隔离开关 | `isolateProjectCwd` **默认关** | `serve.ts:314`、`:407` |
| 平台会建的目录 | 只有默认工作根、以及开关打开时的 `projects/<id>` | `src/platform/infra/settings.ts:250`、`serve.ts:410` |
| 盘上那套命名 | `wk_*` / `pj_*_output` / `secrets/` —— **零平台代码支持** | `grep -rn "wk_\|_output" src/` = 0 命中 |
| 工件正文 | 179 行 / 631 KB(将随重置消失,不再是约束) | SQL 实测 |
| 盘 ↔ 库的边 | 20 条工件正文提到路径,**全是散文**;`metadata_json` 零条记录文件 | SQL 实测 |
| 能读盘的路由 | 只有 `/api/artifacts/:id/commits` | `src/platform/transport/http.ts` 路由逐条 |

**一句话:内容在库、文件在盘,两者之间没有边;而盘上的目录名是模型自己编的。**

---

## 2. 目录形态(输入 1)

```
<workRoot>/projects/<projectId>/          ← 一个项目 = 一个 git 仓库
├── .git/
├── .gitignore                  ← 平台写(§3.3)
├── README.md                   ← 平台写:项目名 / 目标 / 目录约定
├── artifacts/                  ← 工件正文(索引 body_path 指向这里,平台写)
│   └── art_<id>-<slug>.html
├── work/<workId>/              ← agent 的中间产物 / 临时文件
└── services/<name>/            ← 代码服务(Dockerfile 在这里)= code_service 交付物
```

- **按项目分,不按角色分。** 判据是真机那条已经在工作的路径:多个 worker 往同一个项目
  输出目录写各自的章节,PM 再整合 —— 一个角色一个目录会切断它。
- **归属由 git 承载**:一次 `commit --author=<角色>` 就回答了「这份文件是谁的」。
- 目录在 `project_open` 时由平台建好(`git init` + 写 `.gitignore` / `README.md` + 首次提交);
  `work/<workId>/` 在**派发那条工作项时**建好,并把**绝对路径写进任务提示词** ——
  当前这条通道是空的,模型只能自己编目录名。
- `sessionCwd(projectId)` → 无条件返回 `<workRoot>/projects/<projectId>`;
  `isolateProjectCwd` 这个参数**整个删掉**(它当初不敢开的原因是存量文件会失联,输入 6 让它不再成立)。
- 接待会话(`projectId === null`)仍留在工作根,**不建仓**:立项之前没有项目。

---

## 3. git 协议(输入 2)

### 3.1 谁提交:**agent 交代码,平台交其余**

| 提交者 | 提交什么 | author | 时机 |
|---|---|---|---|
| **agent**(`bash` 里自己跑) | 它写的代码 / Dockerfile | 角色中文名 | 回合内,写完就提交 |
| **平台**(housekeeping) | 工件正文 + 其余未提交改动 | 平台 | 回合边界 |

为什么 agent 必须自己提交:`board_write` 那一刻它的代码**还没进任何提交**,
而 `verifyCodeService` 要求 `headCommit` 与真实 HEAD 一致 ⇒ 不提交就写不进交付物。

平台在每次回合结束后再做一次 housekeeping 提交(成功 / 失败 / 超时**都做** —— 失败也要留现场,7-N)。
无变更则跳过(**实测**:`git commit` 无改动返回 1)。

- 实测确认:`git commit --author="业务经理 <bm@sansheng.local>"` 生效 ——
  `author=业务经理 <bm@sansheng.local> | committer=bot <bot@local>`。
- author 的中文名**只有一处来源**:`identity/org.ts` 的 `ORG`。
- **竞争只有一处**:同项目两个角色并发(忙闩的键是 `(项目, agent)`,不是项目),
  一个在提交代码、平台同时做 housekeeping ⇒ 可能撞 `index.lock`。
  处置:**退避重试 3 次**;用尽则**可见地失败**(落一条 `system` 会话消息,下次边界重试),
  不静默吞掉 —— 静默吞掉会让「提交了」与「没提交」在屏幕上长得一样。

### 3.2 交付物就在项目仓里(输入 4)

`code_service` **不建独立仓库**,直接复用项目仓。这一条消掉了原方案里唯一的
「不能照字面执行」处:没有嵌套仓库 ⇒ 没有 gitlink、没有 `git add -f` 的静默失败、
没有「内容不在版本库内」的洞;而且「git 是唯一归档」**无条件成立** ——
交付物的内容真的在项目仓历史里。

> 原方案的探针结论留档,别重走:含 `.git` 的子目录,父仓只能记成 gitlink(mode `160000`);
> 四种写法实测全部无效,其中「`.gitignore` 忽略整目录 + `git add -f <文件>`」是
> **exit 0 而暂存区为空**的静默失败(正样本:普通被忽略文件 `-f` 正常生效)。

代价是**四条纪律**:

#### (a) 交付物的边界用**路径**定义,不能是「仓库」

坐标从 5 项变 6 项(`codeservice/port.ts:101`),新增 `servicePath`(仓库内相对路径):

- `verifyCodeService` 的 ⑥「仓库**根**有 Dockerfile」→「**`servicePath` 内**有 Dockerfile」;
- `files` 读 `servicePath` 的一级条目;`repoName` 取 `servicePath` 的 basename;
- `repoPath` 仍是项目根 ⇒ ①②③④⑤ 一字不改(项目根就是仓库根);
- `servicePath` 必须**在仓库之内**(包含性校验,realpath 之后比)。

**为什么不直接拿项目根当交付物**(那样 5 项都不用改):项目根里有 `artifacts/` 和 `work/`
—— 交付物的边界会消失,`docker build .` 的上下文变成内部工作区;而且一个项目交**两个**服务时,
两条交付物的 `repoPath` 完全相同,读面分不出谁是谁。

#### (b) 交付物的版本按**路径**算,不按 HEAD 算

平台每回合都写工件并提交 ⇒ **HEAD 一直在动**,而交付物根本没变。坐标里再加:

- `deliverableCommit` = `git log -1 --format=%H -- <servicePath>`(最后触及这个服务目录的提交)
- `deliverableSubject` = 它的标题

读面用 `deliverableCommit` 说「这版交付物是什么」;`headCommit` 仍是交付那一刻的仓库现场
(模型照抄 `git rev-parse HEAD`,这项核对不变)。
**判据:平台写一堆工件提交之后 `deliverableCommit` 不动;动了服务目录它必须动。**
`commitCount` 同样按路径算(`git rev-list --count HEAD -- <servicePath>`)。

#### (c) 回滚只许 `revert`,不许 `reset --hard`

交付物与工作区同仓 ⇒ `reset --hard` 会让 `deliverableCommit` 变成**不可达对象**
(只剩 reflog),而库里的索引仍然指着它。读面核对可达性
(`git cat-file -e <sha>^{commit}`),不可达就如实报 `runtime: "unreachable"` ——
**不许**回空列表,也不许假装正常。
因为索引记的是 sha,**用 `revert` 回滚是安全的**。

#### (d) 服务目录别被 `.gitignore` 吃掉

交付物的内容 = **被 git 跟踪的文件**。服务目录里若有被 `.gitignore` 忽略的文件
(本地 `.env`、构建产物),它们不会出现在甲方 clone 到的东西里 ⇒ **交付物静默残缺**。
核对:`git status --ignored --porcelain -- <servicePath>`,**告警不拒绝**
(`node_modules` 这类是正常的),清单进 `CodeServiceFacts.ignoredFiles` 并显示在工件页。

### 3.3 `.gitignore`(平台在 `project_open` 写)+ 提交前闸门

```
# 秘密:永不提交,并在提交时告警
.env
*.key
*.pem
secrets/
# 平台暂存
.platform-tmp/
```

提交前三条闸门,**失败必须可见**:

1. **秘密** → 不提交,并落一条 `system` 会话消息(工作根不该放秘密;`.keyring` 在 `<dataDir>` 且是 0600)。
2. **超大文件**(单文件 > 10 MB)→ 不提交,并**在项目页显示一行「另有 N 个文件因体积未纳入版本库」**。
   ⚠️ 这是「git 取代归档」的**前提**:一次大输出就能把仓库永久污染,而 git 历史不可回收。
3. **服务目录的忽略文件** → §3.2(d),告警。

### 3.4 提交即重建索引(库与盘的接缝)

`commitWorkspace(projectId, reason)`:

1. 扫工作树,对索引里登记的文件**重算 `sha256` / `bytes`**;
2. `git add -A`(过 §3.3 闸门);
3. 无变更 → 返回;否则提交;
4. 回填这批文件的 `commit_sha` = 新 HEAD;
5. 广播一条 workspace 事件,UI 更新。

**这一步让「人工编辑文件」不再让索引说谎**:git 是内容的真相,索引是它的**投影**,
每次提交重建一次。

---

## 4. 索引化(输入 3)

### 4.1 终态 schema(一次重建,见 §5)

`artifacts` 的 `body TEXT NOT NULL` **换成**:

```sql
body_path   TEXT NOT NULL,     -- 项目根相对路径,如 artifacts/art_x-report.html
body_sha256 TEXT NOT NULL,
body_bytes  INTEGER NOT NULL,
commit_sha  TEXT               -- 引入正文的提交(平台提交后回填;未提交时 NULL)
```

⚠️ **`body_path` 不需要「可为 NULL」的例外。** 原稿写的是「仅 `code_service` 可为 NULL」——
那是错的:每个工件都有正文(`board_write` 的 `body` 是必填),`code_service` 的正文
就是那份 markdown 说明,额外坐标在 `metadata_json`。所以三列全 `NOT NULL`,判据更强、分支更少。

### 4.2 读面

- `ArtifactView.body` → `bodyPath` / `bodyBytes` / `commitSha` / `contentRuntime: "ok" | "unavailable"`;
  **列表接口不再带正文**(今天每次列表都把正文拉出来一份)。
- 新增 `GET /api/artifacts/:id/content?at=<sha>`:
  - 默认读 **HEAD**;`at=` 读历史版本(`git show <sha>:<path>`);
  - 文件不在 HEAD(被删 / 被回滚 / 被人工移走)→ `runtime: "unavailable"` + `problem`,
    **不是空正文**;
  - 索引记了 `commit_sha` ⇒ **历史版本永远读得出来**,这是「回滚安全」的依据(§3.2c)。
- `code_service` 的读面增加 `servicePath` / `deliverableCommit` / `deliverableSubject` / `ignoredFiles`;
  `GET /api/artifacts/:id/commits` 改成**按 `servicePath` 过滤**
  (否则「这个服务改了什么」会混进平台写工件的提交)。
- 渲染面**保持** `<iframe sandbox="" srcDoc>`:改成 `<iframe src="/api/artifacts/:id/content">`
  会让模型写的 HTML 与应用**同源** —— 那个 `sandbox=""` 是**结构性保证,不是过滤器**。
  正文经 fetch 拿到文本后仍走 `srcDoc`。

### 4.3 写面

- 新增端口 **`WorkspacePort`**(`read` / `writeAtomic` / `stat` / `list` / `commit` / `show` / `log`):
  真实现落盘 + git,测试注入假的 —— 与 `MemoryPort` / `ClientChannel` / `CodeServicePort` 同构
  (工具层必须是纯函数 + 显式注入依赖)。
- `board_write`:**先原子写文件,后插行**。顺序不能反 ——
  反了会得到「有索引无内容」;正着最坏只留一个**孤儿文件**(可检测、可回收)。
- 路径**由平台生成**:`artifacts/<artifactId>-<slug>.<ext>`(`html_report` → `.html`,其余 → `.md`)。
  **不让模型编路径。**
- 路径校验:realpath 之后做**包含性**比较,**符号链接也拦得住** —— 复用 `codeservice/git.ts` 的做法。

### 4.4 一致性两端可见

`GET /api/projects/:id/workspace` 返回目录树 + 每条目状态:

`indexed`(盘上有、索引里有)/ `orphanFile`(盘上有、索引里没有)/
`missing`(索引里有、盘上没有)/ `size`;
**根不存在时 `runtime: "unavailable"` + `problem`,不是空目录。**
今天盘对整个 UI 是黑盒 —— 这是唯一能看到盘的路由。

### 4.5 范围:工件正文,不含对话与记忆

| 内容 | 去哪 | 为什么不搬 |
|---|---|---|
| `artifacts.body`(全部 kind) | → 文件 | 输入 3 的对象 |
| `session_messages`(对话正文) | **留库** | 库是唯一能对上 `project_sessions.id` 的真相;`agent/sessions/*.jsonl` 按 cwd 命名、对不上号。搬走会重新打开「重启失忆」那个洞 |
| `memory_fragments` / `memory_profile` | **留库** | 它要被 `memory_search` 检索,不是文档 |

⚠️ **`client_question` / `decision` 是唯一失去跨表事务性的地方**:今天「提问落库 + 推给甲方」
是一个事务;现在是「写文件 → 插行」。缓解 = §4.3 的文件先行 + §4.4 的两端对账。
**有意的取舍,不是遗漏。**

---

## 5. 一次性交付:没有迁移

输入 6 ⇒ 存量数据(179 条工件 / 4 个项目 / 42 工作项)不要了。于是:

- **不写回填脚本**、**不做目录归位**、**不建 `_unassigned/`**、**不保留 `body_legacy` 过渡列**。
- 一次 schema 变更到终态:`migrations/027_artifact_body_files.sql` **重建 `artifacts`**
  (登记进 `INTENTIONAL_REBUILDS`,与 012 / 016 / 026 同一套做法),直接落地 §4.1 的四列。
- `isolateProjectCwd` 与 `serve.ts` 里那条分支**直接删**(不用等迁移完成)。
- 用户会 `reset` 后再验证 —— 所以「重置之后还能跑通」是验收的一部分,不是附带条件。

---

## 6. 实施顺序(依赖顺序,不是分期)

同一批交付,内部按依赖走:

1. **schema**:027 重建 `artifacts`(§4.1)。
2. **端口**:`WorkspacePort` + 落盘/git 真实现(`src/platform/workspace/`)。
3. **项目仓生命周期**:`project_open` 建目录 + `git init` + `.gitignore` / `README.md` + 首次提交;
   派发工作项时建 `work/<workId>/` 并把绝对路径写进任务提示词。
4. **写面**:`board_write` 走 `WorkspacePort`(先文件后行);提交前三条闸门。
5. **读面**:`ArtifactView` 换字段 + `GET /api/artifacts/:id/content` + workspace 路由(已有)。
6. **提交协议**:回合边界的 housekeeping 提交 + 索引重建 + `index.lock` 退避重试。
7. **`code_service` 契约**:`servicePath` / `deliverableCommit` / `ignoredFiles`(§3.2)
   + 编码工提示词(删掉「先 `git init`」)。
8. **前端**:工件正文改 fetch(仍 `srcDoc`)、`CodeService` 加新字段、项目页文件系统段。
9. **清理**:删 `isolateProjectCwd`、`sessionCwd` 改成无条件按项目。

---

## 7. 交付口径(输入 5)与明确不做

**交付物 = `services/<name>/` 这个构建上下文;甲方拿到整个项目仓。**

```
git clone <项目仓>
docker build services/<name>
docker run -p <port> ...
```

镜像的干净度由服务目录里的 `.dockerignore` 负责(排除 `node_modules` / 构建产物)。
内部工作记录(`artifacts/` 报告、`work/` 中间产物)**随仓一起对甲方可见** ——
这是**有意的透明交付**。

> ⚠️ **连带后果:`.gitignore` 闸门从「卫生」升级为「披露控制」。**
> 甲方拿到的就是被提交的东西,所以 §3.3 的三条闸门不再是内部整洁问题:
> 第 1 条是**唯一**挡在秘密与甲方之间的机制;第 2、3 条产生的「没纳入」必须显示
> —— **没进去的东西和进去的东西都要看得见。**

**不做**:

- 不做数据迁移 / 回填 / 目录归位(输入 6)。
- 不做 `archive` 导出端点:交付物已经是仓内一个目录,再补一条通道是为一件没发生的事做机制;
  真需要时它是**现读**的,随时能加。
- 不做归档动作(输入 2)—— 现在这句话**无条件成立**。
- 不做 UI 回滚:索引记 sha 之后 `revert` 回滚在机制上是安全的,但 UI 要重新设计。
- 不把工作根做成一个大仓:项目间互不污染、`project_close` 天然封存。
- 不动对话与记忆(§4.5)。

---

## 8. 代价(诚实清单)

1. **备份不再是单文件**:`cp sansheng.db` 不够了 —— 备份 = 库 + 工作根(工作根自带 git 版本)。
2. **失去一件事务性**(§4.5 的 `client_question` / `decision`)。
3. **新失败模式**:路径腐坏(`unavailable`)、人工编辑造成的 sha 漂移(靠 §3.4 收敛)、
   交付物提交不可达(`unreachable`,`reset --hard` 造成,§3.2c)、housekeeping 提交撞锁(§3.1)。
4. **`code_service` 契约从 5 项变 6 项** —— 一次显式的类型变更,不是兼容的加法。
5. **测试面**:47 个测试文件触及 `body`;`src/` 侧集中在 5 个文件
   (`repo/artifacts.ts` / `tools/blackboard.ts` / `tools/collab.ts` / `transport/http.ts` / `transport/views.ts`),
   `web/src` 侧 4 个。
6. ⚠️ **这不是性能优化**:库本来就不大。**价值是架构性的** ——
   内容可 diff、可版本化、可回滚,并给将来的大交付物留路。

---

## 9. 验证

现有链(改完必须全过):

```
npx tsc -p tsconfig.server.json --noEmit
npx tsc -p tsconfig.web.json --noEmit
npm test          # 基线 1672 passed / 82 files(本次改动会增减)
npm run build
npm run check:design
```

新增测试(**每条都带正负样本** —— 「跑完没报错」不是判据):

- **路径包含性**:`../escape` 与符号链接逃逸**必须被拒**;项目内正常路径**必须通过**;
- **`code_service` 六项核对**:`servicePath` 指向仓库外 / 没有 Dockerfile / 不是目录 → **必须拒**;
  正样本**必须通过**;
- **交付物版本**:平台写一堆工件提交后 `deliverableCommit` **不动**;动了服务目录它**必须动**;
- **可达性**:`revert` 之后仍可达;`reset --hard` 之后报 `unreachable`(**不是**空列表);
- **忽略文件**:服务目录里放一个被忽略的文件 → 告警出现;干净目录 → 不出现;
- **提交协议**:并发提交不静默丢改动(重试后成功,或用尽后**可见地失败**);无变更不产生提交;
- **索引**:`board_write` 之后文件真的在盘上且 sha 与行一致;sha 不匹配 → 可见地报出;
  文件不在 HEAD → `unavailable`(**不是空正文**);`at=<sha>` 读得出历史版本;
- **workspace 路由**:根不存在 → `unavailable` + `problem`(**不是空数组**);
- **渲染**:源码 grep 钉住 `srcDoc` + `sandbox=""`,并确认**没有**新增 `<iframe src=`;
- **重置后能跑通**:`--data <临时目录>` 首跑 → `project_open` → 目录与仓真的建出来。

真机:临时 dataDir + `platform-serve` 跑一个真项目,核对 `git log`(author = 角色)、
`/content` 三态、`git status` 干净、`services/` 的目录结构与 Dockerfile 位置。

---

## 10. 需要同步的文档

改到相关结构时**顺手**改,别攒着:

- `docs/DESIGN-PLATFORM.md`:存储节(§8.x)与 `code_service` 坐标那一节(§7.4 一带);
- `docs/DESIGN-AGENTS.md`:编码工那节(「交一个 git 仓库」→「交项目仓里一个服务目录」);
- `AGENTS.md` 的「数据与存储」与「交付物类型」两节;
- `HANDOFF.md` 的批次记录。

⚠️ `check-design-consistency.mjs` 只读 `DESIGN-PLATFORM.md` 与 `DESIGN-AGENTS.md` 两份
(第 41–42 行硬编码路径),本文不影响 `check:design` —— 但改上面那两份时要跑它。
