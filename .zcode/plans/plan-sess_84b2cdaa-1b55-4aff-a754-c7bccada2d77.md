# 三生前端重做（已确认方向：Multica 设计体系参照 + Sansheng 领域不动）

## 批次与执行内容

**批次 0（本次）**：
1. 本地 master 提交 v5 现状为回滚锚点（不 push）
2. `docs/DESIGN-FRONTEND-V2.md` 设计书（领域动线/IA/交互/token/架构/批次）
3. `docs/DOMAIN-MODEL.md` 更新（补 033/034 列、页面契约改新 IA、修过时处）
4. 新 token 体系落地：`styles/tokens.css` 重写（四层 Foundations + 旧变量名兼容别名——旧组件读 `--ink-*` 照常工作，视觉即刻切深色科技办公）+ `styles/theme.css`（组件语义层 + works/裁决/优先级状态色映射）
5. 对比度哨兵测试（WCAG 4.5:1 量出来）+ 依赖方向哨兵测试（app→features→entities→shared）
6. `npm run typecheck` + `npx vitest --run tests/web` 全绿

**批次 1–5（后续）**：外壳（AppShell frame+页卡+左栏恒在）→ stores 三域拆分 → 对话域（行动区）→ 工作项域拆文件 → 其余域 → 删旧收口。后端零改动。

## 关键裁决（已与用户确认）

- 借鉴 Multica：页面即卡片布局、六阶表面亮度阶梯、token 四层、字号阶梯、CJK 字体工程、对比度 CI、Run 回放增强成员面板
- 不抄：看板、shadcn 全家桶、主题系统、Inbox 一级页
- 不变：后端契约、领域模型、四个等甲方状态点、对话主轴、v5 中正确的判据（并发板/三视图/塌缩/四态纪律/WS revision 回查）