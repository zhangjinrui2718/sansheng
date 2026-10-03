#!/usr/bin/env python3
"""Sansheng 授权求解链路 · 设计 1 §4
一个全局 Agent 从「我是什么角色」到「我手里有哪些工具」中间经过的三道门
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

plt.rcParams["font.family"] = ["PingFang HK", "Arial Unicode MS"]

fig, ax = plt.subplots(figsize=(17.0, 10.2), dpi=130)
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")
fig.patch.set_facecolor("white")

PAL = {
    "in":    ("#eef2f5", "#7b8794"),
    "calc":  ("#e8f0fe", "#4a6fa5"),
    "g1":    ("#fff4e5", "#c77d1a"),
    "g2":    ("#ffe8e8", "#c0392b"),
    "g3":    ("#f3e8fd", "#7e4ab5"),
    "out":   ("#e8f5e9", "#2e7d32"),
    "sdk":   ("#e8f5e9", "#2e7d32"),
    "panel": ("#fdfdfd", "#b9c2cc"),
}
SPINE = "#5a6b7d"


def box(x, y, w, h, title, lines=(), kind="calc", fs=10.0, lfs=8.0,
        z=3, ls="-", lw=1.7, sp=1.95, title_color="#12203a"):
    fc, ec = PAL[kind]
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.3,rounding_size=1.0",
        facecolor=fc, edgecolor=ec, linewidth=lw, linestyle=ls, zorder=z))
    n = 1 + len(lines)
    top = y + h - h / (n + 1.0) * 0.92
    ax.text(x + w / 2, top, title, fontsize=fs, fontweight="bold",
            color=title_color, ha="center", va="center", zorder=z + 1)
    for i, ln in enumerate(lines):
        ax.text(x + w / 2, top - 2.3 - i * sp, ln, fontsize=lfs,
                color="#3d4a5c", ha="center", va="center", zorder=z + 1)


def arrow(p1, p2, color=SPINE, lw=2.1, z=2, ls="-"):
    ax.add_patch(FancyArrowPatch(
        p1, p2, arrowstyle="-|>", mutation_scale=15, linewidth=lw,
        color=color, linestyle=ls, zorder=z, shrinkA=1, shrinkB=1))


# ── 标题 ─────────────────────────────────────────────────────────
ax.text(3.0, 99.2, "Sansheng 授权求解链路", fontsize=15.5, fontweight="bold",
        color="#12203a", ha="left", va="top")
ax.text(3.0, 96.4, "工具 = 能力 × 作用域  ——  三道门只减不增,集合文件突破不了任何一道",
        fontsize=9.8, color=SPINE, ha="left", va="top")

LX, LW = 4.0, 40.0          # 左列:求解流水线
RX, RW = 49.0, 47.0         # 右列:各门语义与失败模式

# ── 左列:流水线 ─────────────────────────────────────────────────
box(LX, 83.4, LW, 10.0, "输入",
    ["Agent(全局角色)+ Project(参与关系)",
     "RoleSpec — 代码内常量,不可变",
     "ToolSetFile — 用户可编辑"],
    kind="in", fs=10.2, lfs=8.0)
arrow((LX + LW / 2, 83.4), (LX + LW / 2, 79.6))

box(LX, 70.2, LW, 9.4, "①②③  取值与合并",
    ["ceiling   = spec.ceiling",
     "requested = allow \\ deny"],
    kind="calc", fs=10.0, lfs=8.2)
arrow((LX + LW / 2, 70.2), (LX + LW / 2, 68.4))

box(LX, 58.8, LW, 9.6, "门 1 · ceiling   架构上界",
    ["inCeiling = requested ∩ ceiling"],
    kind="g1", fs=10.0, lfs=8.2)
arrow((LX + LW / 2, 58.8), (LX + LW / 2, 57.0))

box(LX, 45.4, LW, 11.6, "门 2 · scope   项目参与关系",
    ["scoped = inCeiling ∩ ScopeGate",
     "三条规则见右 →"],
    kind="g2", fs=10.0, lfs=8.2)
arrow((LX + LW / 2, 45.4), (LX + LW / 2, 43.6))

box(LX, 33.6, LW, 10.0, "门 3 · writeKind   写面白名单",
    ["kinded = scoped ∩ WriteKindGate"],
    kind="g3", fs=10.0, lfs=8.2)
arrow((LX + LW / 2, 33.6), (LX + LW / 2, 31.8))

box(LX, 20.2, LW, 11.6, "EffectiveToolSet",
    ["tools = Expand(kinded) + projectId",
     "→ createAgentSession",
     "({ tools, customTools })"],
    kind="out", fs=10.4, lfs=8.2)
arrow((LX + LW / 2, 20.2), (LX + LW / 2, 18.4))

box(LX, 8.4, LW, 10.0, "SDK 机制级过滤 · isAllowedTool",
    ["builtin / extension / customTools",
     "统一过滤,只有名单内工具被激活"],
    kind="sdk", fs=9.6, lfs=8.0, ls=(0, (5, 3)), lw=1.4)

# ── 右列:各门语义 ───────────────────────────────────────────────
box(RX, 57.4, RW, 12.4, "门 1 语义 · 角色原则上能不能做这类事",
    ["架构上界写在 ROLE_SPECS 里,是一次显式代码评审",
     "越界项 → blockedByCeiling",
     "log.warn + UI 琥珀划线(提权失败必须对用户可见)"],
    kind="panel", fs=9.6, lfs=8.0, sp=2.1)

box(RX, 43.2, RW, 15.0, "门 2 语义 · 在这个项目里能对谁做",
    ["R1   client.ask / client.message → 需 spec.clientFacing",
     "       (代码内常量,非运行时数据)",
     "R2   collab.ask / collab.escalate → 目标须在本项目",
     "R3   其余项目内能力 → 需 project.status = active",
     "拒绝 → blockedByScope + 理由对用户可见"],
    kind="panel", fs=9.6, lfs=7.9, sp=2.05)

box(RX, 30.6, RW, 13.0, "门 3 语义 · 能写,但能写哪几种记录",
    ["blackboard.write 的 kind 参数须在 spec.writeKinds 内",
     "拒绝 → 结构化错误 + 回灌合法 kind 列表",
     "(\"传错参数\"的表现形式往往是编造 — 8-F 教训)"],
    kind="panel", fs=9.6, lfs=7.9, sp=2.1)

# ── 右下:三道门的分工 ───────────────────────────────────────────
box(RX, 9.6, RW, 17.2, "三道门各有分工,不是冗余",
    ["ceiling   →  这个角色原则上能不能做这类事",
     "scope     →  在这个项目里、以这个身份,能对谁做",
     "writeKind →  能写,但能写哪几种记录",
     "",
     "最窄一例:质检审查员有 blackboard.write,",
     "但 writeKinds 只有 [\"review_finding\"]",
     "→ 能发言,但不能污染其他记录"],
    kind="panel", fs=9.6, lfs=7.9, sp=1.95)

plt.savefig("arch-authz.png", dpi=130, bbox_inches="tight",
            facecolor="white", pad_inches=0.22)
print("saved arch-authz.png")
