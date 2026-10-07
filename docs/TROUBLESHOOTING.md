# Sansheng 故障排查手册 —— **已失效(旧系统)**

> ⚠️ **这份文档描述的是 2026-10-04 清场之前、已经被整体删除的旧系统。它不能照着做。**
>
> 2026-10-02 批次 7 排查三个用户反馈时整理,配套 `npm run diagnose`。
> 那份脚本(`scripts/diagnose.mjs`)与 `diagnose` npm script 已于批次 19 一并删除 ——
> 它读的是 `blackboards` / `conversations` 表,而这两张表连同另外 5 张旧表
> 已被 `migrations/011_drop_legacy.sql` **DROP**。在任何新平台数据目录上跑它,
> 只会得到 `no such table: conversations`,而不是诊断结果。
>
> 为什么删脚本而留这份说明:一个「跑得动但结论恒错」的工具有毒 ——
> 它「成功」的唯一原因是用户的主库恰好还是旧存量库。留着它,下一个人还会照它排查。
>
> **原文逐字保存在 git 历史里**(不是篡改,是归档):
>
> ```bash
> git show e3d2812:docs/TROUBLESHOOTING.md      # 本文档失效前的全文(220 行)
> git show e3d2812:scripts/diagnose.mjs        # 被删的诊断脚本(17.8 KB)
> ```

---

## 里面仍然成立的教训,已经搬去哪

那份文档记的**事故**是真的,而且已经蒸馏进现行规范,**不要因为文档失效而丢掉它们**:

| 当年的教训 | 现在的落点 |
|---|---|
| **7-B 提示词「落地了但没人读」** —— Planner/Executor 拿的是模块内 stub,`shared/prompts/planner.md` 那份 91 行正经提示词零调用方;用户在 harness 里怎么改都没用 | `AGENTS.md` §提示词(harness)+ §仍然成立的教训 #1;由 `src/platform/runtime/promptAssembly.ts` 装载 + `platform smoke` 的「声明了但盘上没有」告警承载 |
| **日志基本别指望** —— `logs/sansheng.log` 恒为 0 字节,日志只走 stdout | `AGENTS.md` §项目速览最后一条 |
| **失败必须留现场** —— `exec-err-*` 那条 note 的 body 里存着失败那一刻的原始模型输出,是整个系统里最有取证价值的东西 | `AGENTS.md` §仍然成立的教训 #4 / #5 |
| 「改完之后报成功、实际没生效」这一类 | `AGENTS.md` §三类静默失败 + `harness/write.ts` 规矩③(报成功 = 真生效) |

## 现在的等价操作(照着这些,不要照着上面那份)

```bash
# 起常驻宿主(HTTP + WS + 托管前端 + 调度器);默认 127.0.0.1:2718
node dist/src/cli/index.js platform-serve --data <数据目录> --port <端口>

# 真 provider 建真会话,校验「声明 vs SDK 实际激活」,并列出缺失的提示词单元
node dist/src/cli/index.js platform smoke --role <role> --data ~/.sansheng
```

- **日志**:只走 stdout(见上表)。别去找历史日志文件,没有。
- **数据在哪**:默认 `~/.sansheng/`(`--data` / `SANSHENG_DATA` 可覆盖);
  表结构以 `migrations/` 为准 —— **不要凭本文档 §1 那张旧表结构图想象**。
- **提示词改了没生效怎么查**:打开界面上的 Harness 页(`GET /api/harness`),
  它如实报每个单元的 `loaded` 与每个角色的**有效工具面**(ceiling ∩ 集合文件 ∩ scope);
  盘上缺单元会红标「缺失」。
- **工具集合文件(`harness/tools/{role}.json`)改了没生效怎么查**:同一页每个角色的
  「集合文件」一行 —— `ok` 才是生效,`invalid` 会响亮报出并说明它当前**没有生效**
  (权限回落到 ceiling 全集)。
- **验证链**(改完必须全过):`AGENTS.md` §验证链。
