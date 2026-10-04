# 三生 · Sansheng

> 一个数字机器人雇员。Token 是工资,产出是工件。
> 它能沟通 / 思考 / 行动,且会**持续优化自己的 harness** 越来越好地完成你的任务。

## 启动

```bash
npm install
npm run build       # 产出 dist/cli.js + dist/web
npm link             # 或 npm i -g . → 全局 sansheng 命令
sansheng start --daemon       # 后台启动
sansheng status               # 查看 pid / port
open http://localhost:2718    # 进入 Web UI
sansheng stop                 # 停止
sansheng logs                 # tail 日志 (~/.sansheng/logs/sansheng.log)
sansheng reset -y             # 清空 ~/.sansheng
```

## 开发

```bash
npm run dev         # 并发启 server (tsx watch) + web (vite)
                    # 浏览器开 http://localhost:5173
                    # Vite 把 /api & /ws 代理到 server :2718
```

## 命令

| 命令 | 作用 |
|---|---|
| `sansheng start [--daemon] [--host H] [--port P] [--data DIR] [--open]` | 启动 |
| `sansheng stop` | 停止 |
| `sansheng status` | pid / uptime |
| `sansheng logs [-n N] [-f]` | 日志 |
| `sansheng reset [-y]` | 清空数据 |

## M1 使用流程

1. `sansheng start` 后浏览器访问 `http://localhost:2718`
2. 首启会看到「未配置 API Key」提示 → 点「去设置」
3. 在设置页选 Provider / Model / 输入 API Key / 设置工作目录 → 保存
4. 回到对话页 → WebSocket 自动连上 Pi SDK → 输入回车即可对话
5. 思考 / 工具调用 / 结果实时渲染;顶栏右侧显示本轮 token + 累计成本

## WebSocket 协议

`PUT /api/settings` body `{provider, modelId, apiKey, ...}` 保存
`WS /ws` 双向 JSON:
- Client → Server: `{type:"send", content}`, `{type:"interrupt"}`, `{type:"ping"}`
- Server → Client: `ready` / `agent_start` / `turn_start` / `message_start` / `delta` / `thinking_delta` / `tool_start` / `tool_end` / `message_end` / `agent_end` / `error` / `interrupt`

## 里程碑

- [x] **M0 骨架** — Hono server + React SPA + 设计 tokens + CLI start/stop/status/logs/reset
- [x] **M1 Kernel + 单 agent 对话** — Pi SDK 接入 + WS 流式 + Settings + Provider + cost tracker + 基础 shell/read/write 工具
- [ ] M2 持久化 + 记忆 — SQLite + sqlite-vec
- [ ] M3 多 agent — Planner / Executor / Critic / Memory / Reflection + Blackboard
- [ ] M4 行动工具 — fs / http / browser / notify
- [ ] M5 Artifacts — 6 种 kind + 快照
- [ ] M6 Harness 自我优化
- [ ] M7 守护调度 + 目标 + 反思
- [ ] M8 失败兜底 + 进度报告

## 设计哲学

- **数字雇员**(非工具/朋友/助手):任务进来,产出工件。
- **三栏布局**:历史 / 对话 / Blackboard+Trace
- **水墨青玄**:深墨底 + 青玄主色 + 赭 + 朱砂,克制动效
- **中文 only**:后续 i18n 可加,先不引框架
- **不依赖 Electron**:纯 npm 包,浏览器访问 `localhost:2718`

详见 [`docs/DESIGN-PLATFORM.md`](docs/DESIGN-PLATFORM.md)。(原 `PLAN.md` 已于 2026-10-04 删除 —— 它描述的旧系统在批次 15 清场时整体移除。)