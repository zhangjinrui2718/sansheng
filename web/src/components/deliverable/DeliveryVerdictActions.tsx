/**
 * 甲方对一份交付物的**验收动作**(029)—— 交付物卡与项目的「待收货」共用。
 *
 * ── 为什么两个挂载点共用一个组件 ─────────────────────────────────
 *
 * 同一件事(接受 / 要改)在两个地方出现:交付物卡(工作项页,甲方在那里读正文)
 * 与项目的「待收货」清单(项目页,甲方在那里看「有什么在等我」)。两份实现迟早
 * 会长歪 —— 而这个项目为「两份定义会漂」付过好几次代价,所以动作只有这一份。
 *
 * ── 三条界面纪律 ────────────────────────────────────────────────
 *
 *   ① **「还没表态」不许渲染成任何一种裁决**。`acceptance.verdict === null` 时
 *      显示的是「**等你验收**」,不是「已接受」/「待定」—— 后者都是替甲方说了话。
 *   ② **还没交付就不显示动作**:没收到货谈不上验收。这不是前端藏按钮,后端也会
 *      拒(`not_delivered` 409);前端不显示只是别让用户白点一次。
 *   ③ **拒收的理由不强制填**。强制填的按钮会把人推向「接受」—— 而一次假的接受
 *      比一句没写理由的拒收坏得多(前者会让项目带着问题收口,后者只是作者要
 *      多问一句)。所以按钮始终可点,只提示「不写的话作者只知道你拒收了」。
 *
 * ⚠️ **改判是允许的**:甲方点头之后又发现问题,可以再选「要改」—— 服务端是追加式
 * (每次裁决写一行),读面取最新那条。所以已裁决的卡片上仍然保留两个按钮,
 * 只是把当前那条裁决显示出来。
 */
import { useState } from "react";
import type { ArtifactAcceptanceView } from "@shared/types/platform";
import { Pill } from "@/components/ui/primitives";
import {
  DELIVERY_VERDICT_LABEL,
  DELIVERY_VERDICT_TONE,
  fmtTime,
} from "@/lib/vocab";
import { useChatStore } from "@/stores/chat";

export function DeliveryVerdictActions({
  artifactId,
  title,
  acceptance,
}: {
  artifactId: string;
  /** 只用于按钮文案与无障碍标题(「接受《xxx》」) */
  title: string;
  acceptance: ArtifactAcceptanceView;
}) {
  const submitVerdict = useChatStore((s) => s.submitVerdict);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);

  async function send(verdict: "accept" | "reject") {
    if (busy) return;
    setBusy(true);
    setFailed(null);
    const r = await submitVerdict(artifactId, verdict, note);
    setBusy(false);
    if (r === null) {
      // 服务端四条拒收都带可执行的处置(不是交付物 / 已收口 / 还没交付给你 /
      // 理由太长)。store 把 message 放进了 `error`,这里如实显示 ——
      // 一个点了没反应的按钮比一句「为什么不行」坏得多。
      setFailed(useChatStore.getState().error?.message ?? "没能提交 —— 这次裁决没有落库。");
      return;
    }
    setNote("");
  }

  // ── 项目已收口:入口关着,而且**要说清这是历史事实**(029 之后的存量库常态)──
  //
  // ⚠️ 这一支不能省:收口不可逆,后端对收口项目一律 409。少写它就会给出一排
  // **兑现不了的按钮**(点了才被拒),与「待答队列里那些收口项目的提问」同款。
  // 真机那个项目 2026-10-07 就 `done` 了,而验收是 10-08 才有的 —— 它的 7 份
  // 交付物全部是「已交付、从没被任何人验收过」。
  if (acceptance.projectClosed) {
    return (
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <Pill tone="mute" title="项目已收口(done / abandoned)—— 收口不可逆,之后不再接受验收">
          {acceptance.verdict === null ? "已交付 · 未被验收" : DELIVERY_VERDICT_LABEL[acceptance.verdict]}
        </Pill>
        <span className="ss-meta">
          {acceptance.verdict === null
            ? "这个项目在验收这件事落地之前就收口了(收口不可逆)—— 这一版没有被任何人验收过。要接着做,请让业务经理开下一个版本。"
            : "项目已收口,这条裁决不再可改。"}
        </span>
      </div>
    );
  }

  // 还没交付给甲方:没有「收货」可言。**如实说明等谁**,不显示动作。
  if (!acceptance.handedOver) {
    return (
      <div className="mt-1 flex items-center gap-2 flex-wrap">
        <Pill tone="mute" title="平台里还没有它的交付会话">
          未交付
        </Pill>
        <span className="ss-meta">业务经理还没把这份交给你 —— 交出去之后这里才是你验收的地方。</span>
      </div>
    );
  }

  return (
    <div className="mt-1.5 rounded" style={{ border: "1px solid var(--ink-3)", padding: "6px 8px" }}>
      <div className="flex items-center gap-2 flex-wrap">
        {acceptance.verdict === null ? (
          <Pill tone="amber" title="已交付,等你表态">
            等你验收
          </Pill>
        ) : (
          <Pill
            tone={DELIVERY_VERDICT_TONE[acceptance.verdict]}
            title={acceptance.at === null ? undefined : fmtTime(acceptance.at)}
          >
            {DELIVERY_VERDICT_LABEL[acceptance.verdict]}
          </Pill>
        )}
        <span className="ss-meta">
          {acceptance.verdict === null
            ? "已经交到你手上了。收不收由你说 —— 这里点了才算数。"
            : acceptance.verdict === "accept"
              ? "你已经接受了这一版。发现问题可以改判。"
              : "你要改这一版 —— 平台会把你的理由派回给写它的人。"}
        </span>
      </div>

      {acceptance.note !== null && acceptance.note.length > 0 && (
        <div className="ss-meta mt-1" style={{ color: "var(--bone-dim)", whiteSpace: "pre-wrap" }}>
          你说的:{acceptance.note}
        </div>
      )}

      <div className="mt-1.5 flex items-start gap-2 flex-wrap">
        <textarea
          rows={2}
          value={note}
          placeholder="要改的话,写一句哪里不行 —— 这句话会原样进作者的任务(不写也行,那时他只知道你拒收了)"
          onChange={(e) => setNote(e.target.value)}
          style={{
            flex: "1 1 220px",
            minWidth: 180,
            background: "var(--ink-1)",
            border: "1px solid var(--ink-3)",
            borderRadius: 6,
            padding: "5px 7px",
            fontSize: 12,
            color: "var(--bone)",
            outline: "none",
            resize: "vertical",
          }}
        />
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            className="sansheng-button-primary"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={busy}
            title={`接受《${title}》—— 记录下「甲方认可了这一版」`}
            onClick={() => void send("accept")}
          >
            {busy ? "提交中…" : "接受"}
          </button>
          <button
            type="button"
            className="sansheng-button"
            style={{ padding: "4px 12px", fontSize: 12 }}
            disabled={busy}
            title={`要改《${title}》—— 平台会退回给写它的人重做`}
            onClick={() => void send("reject")}
          >
            要改
          </button>
        </div>
      </div>

      {failed !== null && (
        <div className="ss-meta mt-1" style={{ color: "var(--cinnabar)" }}>
          {failed}
        </div>
      )}
    </div>
  );
}
