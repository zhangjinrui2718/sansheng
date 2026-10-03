#!/usr/bin/env python3
"""Sansheng 平台架构图 · 设计 1
分层:Client → Transport → 领域上下文 → Harness(BC0+BC5) → Execution → Storage
"""
import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch

plt.rcParams["font.family"] = ["PingFang HK", "Arial Unicode MS"]

fig, ax = plt.subplots(figsize=(17.0, 10.6), dpi=130)
ax.set_xlim(0, 100); ax.set_ylim(0, 100); ax.axis("off")
fig.patch.set_facecolor("white")

PALETTE = {
    "ext":   ("#ffe8e8", "#c0392b"),
    "trans": ("#fff8e1", "#c9a227"),
    "ctx":   ("#e8f0fe", "#4a6fa5"),
    "idn":   ("#f3e8fd", "#7e4ab5"),
    "auth":  ("#fff4e5", "#c77d1a"),
    "exec":  ("#e8f5e9", "#2e7d32"),
    "store": ("#eef2f5", "#7b8794"),
}
SPINE = "#5a6b7d"


def band(y, h, title, color, x=3.0, w=94.0):
    """层背景带;标题占顶部一行,卡片区留出净空"""
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.3,rounding_size=1.2",
        facecolor="#fbfbfd", edgecolor=color, linewidth=1.1,
        linestyle=(0, (6, 4)), zorder=1))
    ax.text(x + 1.4, y + h - 1.7, title, fontsize=10.2, color=color,
            fontweight="bold", va="center", ha="left", zorder=5)


def box(x, y, w, h, title, lines=(), kind="ctx", fs=10.0, lfs=8.0, z=3):
    fc, ec = PALETTE[kind]
    ax.add_patch(FancyBboxPatch(
        (x, y), w, h, boxstyle="round,pad=0.3,rounding_size=1.0",
        facecolor=fc, edgecolor=ec, linewidth=1.7, zorder=z))
    n = 1 + len(lines)
    top = y + h - h / (n + 1.0) * 0.92
    ax.text(x + w / 2, top, title, fontsize=fs, fontweight="bold",
            color="#12203a", ha="center", va="center", zorder=z + 1)
    for i, ln in enumerate(lines):
        ax.text(x + w / 2, top - 2.25 - i * 1.95, ln, fontsize=lfs,
                color="#3d4a5c", ha="center", va="center", zorder=z + 1)


def arrow(p1, p2, color=SPINE, lw=1.9, ls="-", rad=0.0, z=2):
    ax.add_patch(FancyArrowPatch(
        p1, p2, arrowstyle="-|>", mutation_scale=15, linewidth=lw,
        color=color, linestyle=ls, zorder=z,
        connectionstyle=f"arc3,rad={rad}", shrinkA=1, shrinkB=1))


# ── 标题 ─────────────────────────────────────────────────────────
ax.text(3.0, 99.0, "Sansheng 平台架构 · 设计 1", fontsize=15.5,
        fontweight="bold", color="#12203a", ha="left", va="top")
ax.text(3.0, 96.3, "角色是全局的人;工具 = 能力 × 作用域",
        fontsize=9.8, color=SPINE, ha="left", va="top")

# ── Row 1: Client ────────────────────────────────────────────────
box(40.0, 88.0, 20.0, 6.4, "甲方 · Client", ["需求提出方 · 唯一外部干系人"],
    kind="ext", fs=11.5, lfs=8.2)
arrow((50, 88.0), (50, 85.6), color="#c0392b", lw=2.2)
ax.text(51.2, 86.8, "client.*  仅业务经理持有", fontsize=8.6, color="#c0392b",
        ha="left", va="center", style="italic")
ax.text(97.0, 91.2, "甲方永不可直达领域层或执行层", fontsize=8.2,
        color="#c0392b", ha="right", va="center", style="italic")

# ── Row 2: Transport ─────────────────────────────────────────────
band(76.4, 9.2, "Transport", "#c9a227")
box(21.0, 77.6, 26.0, 6.0, "HTTP · Hono", ["REST 面 · 资源读写"], kind="trans",
    fs=9.8, lfs=7.8)
box(53.0, 77.6, 26.0, 6.0, "WebSocket", ["事件多播 · 提问投递"], kind="trans",
    fs=9.8, lfs=7.8)
arrow((50, 76.4), (50, 74.3))

# ── Row 3: 领域上下文 ────────────────────────────────────────────
band(58.5, 15.8, "领域上下文   (BC1–BC4, BC7)", "#4a6fa5")
_bcs = [
    ("BC1  ProjectManagement", ["立项 · 工作分解 · 进度", "Project · Assignment", "Work"]),
    ("BC2  Collaboration", ["提问 · 应答 · 会议", "Ask · Meeting", "Escalation"]),
    ("BC3  Blackboard", ["可审计记录的落点", "Artifact", "10 种 kind"]),
    ("BC4  ChangeControl", ["需求变更 · 阻塞", "ChangeRequest", "Blocker"]),
    ("BC7  Memory", ["简单实现 + MemoryPort", "fragments", "bigram 检索"]),
]
_x0, _bw, _gap = 4.2, 17.2, 1.5
for i, (name, lines) in enumerate(_bcs):
    box(_x0 + i * (_bw + _gap), 59.6, _bw, 10.9, name, lines,
        kind="ctx", fs=9.0, lfs=7.4)
arrow((50, 58.5), (50, 56.4))

# ── Row 4: Harness(BC0 + BC5) ───────────────────────────────────
band(38.5, 17.9, "Harness 装配层   (BC0 + BC5)", "#c77d1a")
box(4.2, 39.8, 25.4, 11.2, "BC0 · Identity  全局角色",
    ["Agent — role · specialization", "RoleSpec — ceiling · writeKinds",
     "clientFacing ← 代码内常量"], kind="idn", fs=9.0, lfs=7.4)
arrow((30.0, 45.4), (35.6, 45.4), color="#7e4ab5", lw=2.3)
ax.text(32.8, 46.9, "提供角色属性", fontsize=7.2, color="#7e4ab5",
        ha="center", va="bottom")
box(36.8, 39.8, 27.4, 11.2, "BC5 · 授权求解",
    ["① ceiling — 架构上界", "② scope — 项目参与关系",
     "③ writeKind — 写面白名单"], kind="auth", fs=9.0, lfs=7.4)
arrow((64.6, 45.4), (70.4, 45.4), color="#c77d1a", lw=2.3)
box(71.6, 39.8, 24.2, 11.2, "EffectiveToolSet",
    ["→ createAgentSession", "   ({ tools, customTools })"], kind="auth",
    fs=9.0, lfs=7.4)
ax.text(96.6, 54.7, "三道门只减不增 —— 集合文件突破不了任何一道",
        fontsize=8.4, color="#8a6a2a", ha="right", va="center", style="italic")
arrow((50, 38.5), (50, 36.4))

# ── Row 5: Execution ─────────────────────────────────────────────
band(20.4, 16.0, "BC6 · Execution   执行运行时", "#2e7d32")
_ex = [
    ("SessionRegistry", ["一项目 N 个 agent 会话"]),
    ("ToolLoop", ["多轮 · 上下文累积"]),
    ("Sandbox", ["文件 / 网络出口门控"]),
]
for i, (name, lines) in enumerate(_ex):
    box(6.0 + i * 30.2, 21.6, 26.6, 10.6, name, lines, kind="exec",
        fs=9.8, lfs=7.8)
arrow((50, 20.4), (50, 18.3))

# ── Row 6: Storage ───────────────────────────────────────────────
band(3.4, 14.9, "通用域 · 持久化", "#7b8794")
box(11.0, 4.6, 34.0, 9.6, "SQLite · 平台表",
    ["agents · projects · works · artifacts", "asks · meetings · blockers · changes"],
    kind="store", fs=9.8, lfs=7.7)
box(55.0, 4.6, 34.0, 9.6, "文件系统",
    ["harness/ · 备份 · 密钥环 · 记忆片段"], kind="store", fs=9.8, lfs=7.7)

plt.savefig("arch-platform.png", dpi=130, bbox_inches="tight",
            facecolor="white", pad_inches=0.22)
print("saved arch-platform.png")
