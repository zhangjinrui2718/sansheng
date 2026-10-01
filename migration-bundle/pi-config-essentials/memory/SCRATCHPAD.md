# Scratchpad

<!-- 2026-09-29 17:05:49 [01a0ec4c] -->
- [x] [BUG · remote verification] Memory Fragments 加载失败: SyntaxError: Unexpected token '<', '<!doctype '... is not valid JSON —— 经典 SPA fallback HTML 替代 JSON 响应,API 端点不存在或失败
<!-- 2026-09-29 17:09:15 [01a0ec4c] -->
- [ ] [BUG · remote verification] User Profile "暂无 profile" —— 可能是 empty state 正常显示(无数据),也可能是 /api/profile 静默失败。已用 onError fix 兜底;让用户 pull 后再看。如果仍空,说明数据真没生成(M3 reflection fragment 还没触发,因为 PI_OFFLINE)。
<!-- 2026-09-29 18:22:15 [01a0ecad] -->
- [x] [B1 worker] Implementing BlackboardArtifact v3 + storage + HTTP endpoints. Files: shared/types/blackboard.ts (new), shared/types/bus.ts (new), src/server/storage/repo/blackboards.ts (update), src/server/storage/db.ts (update), src/server/http.ts (update), migrations/005_blackboard_artifacts.sql (new), tests/server/storage/blackboards.test.ts (new), tests/server/http/{blackboard,artifacts,executors}.test.ts (new)
<!-- 2026-09-29 21:53:24 [01a0ed4d] -->
- [x] [B3+B4 done · 7228268] Orchestrator+Planner+Executor+HarnessManager event-sourced rewrite committed (10 files +1211/-298, 156/156 tests). B3+B4 complete.
- [x] [NEXT · C2 server smoke test] 派 15min worker 跑 server boot + curl /api/health + curl /api/conversations + curl /api/blackboard?scope=global。验证 ws.ts 改动兼容 boot。Reference: B1+B2 commits + HANDOFF.md §C2.
- [ ] [pending · after C2] Upgrade better-sqlite3 ^11.7.0 → ^13.0.3 + engines.node >=20 → >=22. Dispatch as 15min worker, then push all commits together. Reference: package.json: better-sqlite3 + engines.node.
- [x] [pending · after C2] B5-B7 reinforcement (per HANDOFF.md §M3+ B5-B7)。
- [ ] [pending · after C2] 8 manual verification tests (per HANDOFF.md §manual-verification)。
<!-- 2026-09-30 11:25:59 [01a0ed4d] -->
- [x] [NEXT · after Communicator fix worker] 派 C2 server smoke test worker: boot server + curl /api/health + curl /api/conversations + curl /api/blackboard?scope=global。验证 ws.ts 改动 + communicator.ts:279 改动兼容 boot。Reference: HEAD = 640204f (after Communicator fix lands) + HANDOFF.md §C2.
<!-- 2026-09-30 15:26:53 [01a0ed4d] -->
- [ ] [in progress · B5-B7 parallel] 3 worker dispatched at 2026-09-30 15:25 CST: del_muns7psw_46ve (B5 Planner+Executor), del_muns7uct_bpe4 (B6 Harness Manager), del_muns83j7_h4xl (B7 Live Trace+Agent Panel). 45min each. Per jev: B (B5-B7 reinforcement) was best next step (67% conf=0.59); parallel batch mode (n1=0.78).
<!-- 2026-09-30 15:31:49 [01a0f135] -->
- [ ] [B7 · frontend polish] Live Trace + AgentPanel 整合 — 4 improvements identified after reading code:
1. WS reconnect → bus_replay (data loss bug): client never sends bus_replay on reconnect; bus stream is lost. Also busStream in store has no id dedup.
2. WS backoff jitter (thundering herd): exponential 2^n cap 8s, no jitter — many clients reconnect at same time.
3. Timeline a11y + scroll-to-top: only "↓ 跳到最新" button, no "↑ 回到顶部"; no aria-live/role="log"; no keyboard Enter hint on questions.
4. BusRow React.memo: now updates every 5s re-renders all rows.
<!-- 2026-09-30 20:51:09 [01a0f19f] -->
- [x] [BUG · jev-check extension] `ranJevInTurn` 只检查 `event.message` (本 turn 最后一条 assistant message),漏检同一 turn 内更早的 jev bash 调用。Reproduced 2026-09-30 20:38 (m00199 dispatched worker) + 2026-09-30 20:48 (m00224 dispatched worker),两次都因 jev 在 acp_delegate 之前跑(同一 turn)但扩展仍 nudge 1/2。Fix options: (a) scan 整 turn 的所有 messages (需 session context API), (b) 用 tool result entry ids 反查更早 tool calls, (c) 降低 detection 灵敏度: 只在 dispatch 是 turn 唯一 tool call 时 nudge, (d) 加 explicit `ranJev` flag 在 dispatch tool call 的 arguments 里。File: ~/.pi/agent/extensions/jev-check.ts (当前 5650 bytes). 优先级: 中 — 当前只是噪音 nudge (2x 后自动放行),不影响功能。
