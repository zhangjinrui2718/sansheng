/**
 * 对话页右栏 —— **三块**上下并列,共用**同一个**项目详情实例
 *
 * ── 三块各答一句话 ────────────────────────────────────────────────
 *
 * | 块 | 答 | 性质 |
 * |---|---|---|
 * | `AgentPanel`「本项目」 | 现在怎么样 | 摘要(计数 + 未完成工作项) |
 * | `AcceptanceDock`「待你验收」 | 有什么在等我**点头** | 需要甲方动手(029) |
 * | `ClientQuestionDock`「待答」 | 有什么在等我**回答** | 需要甲方动手 |
 *
 * ⚠️ **一个实例,不是三个**:`useProjectDetail` 每个 hook 实例各自 fetch、各自维护
 * `loading`。三块各调一次 ⇒ 同一份数据可能一处写「加载中」、另一处写「没有等你
 * 验收的东西」—— 那就是把「还没查过」渲染成「查过了是空的」。所以 hook 落在**这一层**
 * (`ChatRightRail`),三块只收 props。判据与理由写在 `lib/data.ts` 的 `ProjectDetailState`。
 *
 * ⚠️ **`ChatRightRail` 只挂在 chat 路由下**(见 `App.tsx`)—— 所以那个 5s 兜底轮询
 * 也只在对话页跑。把它提到 `App` 里看着更「统一」,代价是**其余五个页面也一起轮询**。
 */
import { AgentPanel } from "./AgentPanel";
import { AcceptanceDock } from "@/components/client/AcceptanceDock";
import { ClientQuestionDock } from "@/components/client/ClientQuestionDock";
import { useProjectDetail } from "@/lib/data";
import { useChatStore } from "@/stores/chat";

export function ChatRightRail() {
  const projectId = useChatStore((s) => s.projectId);
  const state = useProjectDetail(projectId, { pollMs: 5000 });

  /* 配比:上面 `flex-1`(它在内部滚),下面两块 `flex-none` 且 `maxHeight` 封顶。
     有件可验收 + 有个问题在等时,两块的上界是 35% + 45% ⇒「本项目」仍分得到 ~20%,
     而它内部自己滚 —— 右栏高度有限,任何一块占满都意味着「别的还没查过/没有」。 */
  return (
    <div className="flex flex-col gap-3" style={{ minHeight: 0 }}>
      <AgentPanel state={state} />
      <AcceptanceDock state={state} />
      <ClientQuestionDock />
    </div>
  );
}