/**
 * jev-check Extension
 *
 * Automatic post-turn audit: if the model just dispatched a worker, ran an
 * irreversible command, or proposed a binary choice without first running
 * `jev`, inject a reminder entry and request one continuation turn so the
 * model can run jev (or explicitly justify skipping it) before proceeding.
 *
 * MEMORY preference (sansheng): "任何选择题先跑 jev, 不问 user"
 * + push-first + delegating-code-to-workers preference.
 *
 * Why turn_end (not before_agent_start):
 *   - By turn_end the model's full decision set is visible: tool calls
 *     (acp_delegate, bash, etc.) AND final text.
 *   - This lets us audit decisions AFTER they're made but BEFORE the user
 *     acts on them, with a single continuation budget.
 *
 * Earlier-jev detection (BUGFIX): event.message on turn_end is only the
 *   LAST assistant message. A turn can have multiple assistant messages
 *   (e.g. bash jev.sh then acp_delegate in a follow-up); without the
 *   message_end tracker below, jev calls in earlier messages are missed.
 *
 * Loop guard:
 *   - Nudge at most MAX_NUDGES times per session to prevent infinite loops
 *     if the model keeps ignoring the reminder.
 *   - Counter resets when jev IS run (compliance) or on session_start.
 *
 * Detection signals (OR — any one triggers):
 *   1. acp_delegate tool call  → worker dispatched
 *   2. bash with git push / rm -rf / npm install  → irreversible action
 *   3. text matches /派.+派|或者.+或者|要不|要不要|派哪个|do you want|should I/i  → binary choice in prose
 *
 * jev detection: bash command string contains "skills/jev/scripts/jev.sh".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const JEV_SHELL_MARKER = "skills/jev/scripts/jev.sh";
const MAX_NUDGES = 2;

// ---- Modern UI options menu detection ----

/**
 * Detects lettered/numbered option lists and slash-separated alternatives
 * that the OLD regex didn't cover. The original regex only matched Chinese
 * prose patterns ("要不 X 要不 Y", "或者 X 或者 Y") and a few English verbs;
 * it MISSED modern UI-style menus like "(a) / (b) / (c)" or "Pick: X / Y / Z".
 *
 * Returns true if the text appears to present 2+ mutually-exclusive options.
 */
function looksLikeMenuOptions(text: string): boolean {
	// Lettered/numbered options: 2+ of (a), (b), (c), 1), 2), 一), 二)
	const lettered = text.match(/\(\s*[a-z0-9一二三四五六七八九]\s*\)/gi) ?? [];
	if (lettered.length >= 2) return true;

	// Slash-separated alternatives: 2+ occurrences
	const slashCount = (text.match(/\s+\/\s+/g) ?? []).length;
	if (slashCount >= 2) return true;

	// English menu verbs
	if (/\b(?:pick|choose|select)\s+(?:one|from|between|which)\b/i.test(text)) return true;

	// Chinese menu phrases
	if (/(?:你选哪个|选哪个|请选择|请确认)/.test(text)) return true;

	return false;
}

// ---- Execution detection (non-jev tool calls) ----

/**
 * Did this assistant message contain a tool call that represents actual
 * execution (file edit/write, bash, acp_delegate, etc.) — anything OTHER
 * than a jev bash call or a read. Used to differentiate "model dispatched
 * worker" (executed) from "model asked user" (did not execute).
 */
function hasNonJevToolCall(message: AssistantLike): boolean {
	const toolCalls = getToolCalls(message);
	return toolCalls.some((tc) => {
		if (tc.name === "bash") {
			const cmd = (tc.arguments as { command?: unknown })?.command;
			// jev bash is not execution (it's the compliance signal)
			if (typeof cmd === "string" && cmd.includes(JEV_SHELL_MARKER)) return false;
			// any other bash IS execution
			return true;
		}
		// read is not execution (read-only); everything else is
		return tc.name !== "read";
	});
}

// ---- Message shape helpers (typed against pi-ai runtime types) ----

interface TextBlock {
	type: "text";
	text: string;
}
interface ThinkingBlock {
	type: "thinking";
	thinking: string;
}
interface ToolCallBlock {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
}
type AssistantContent = TextBlock | ThinkingBlock | ToolCallBlock | { type: string };

interface AssistantLike {
	role: "assistant";
	content: AssistantContent[];
}

function isAssistant(message: unknown): message is AssistantLike {
	return (
		typeof message === "object" &&
		message !== null &&
		(message as { role?: unknown }).role === "assistant" &&
		Array.isArray((message as { content?: unknown }).content)
	);
}

function getText(message: AssistantLike): string {
	return message.content
		.filter((c): c is TextBlock => c.type === "text")
		.map((c) => c.text)
		.join("\n");
}

function getToolCalls(message: AssistantLike): ToolCallBlock[] {
	return message.content.filter((c): c is ToolCallBlock => c.type === "toolCall");
}

function getBashCommand(tc: ToolCallBlock): string | null {
	if (tc.name !== "bash") return null;
	const cmd = (tc.arguments as { command?: unknown })?.command;
	return typeof cmd === "string" ? cmd : null;
}

// ---- Decision detection ----

interface DecisionSignal {
	kind: "worker-dispatch" | "irreversible" | "binary-choice";
	detail: string;
}

function detectDecision(message: AssistantLike): DecisionSignal | null {
	const toolCalls = getToolCalls(message);
	const text = getText(message);

	// 1. acp_delegate → worker dispatch
	const workerCall = toolCalls.find((tc) => tc.name === "acp_delegate");
	if (workerCall) {
		const agent = (workerCall.arguments as { agent?: unknown })?.agent ?? "?";
		return { kind: "worker-dispatch", detail: `派了 worker (agent=${String(agent)})` };
	}

	// 2. Irreversible bash patterns
	for (const tc of toolCalls) {
		const cmd = getBashCommand(tc);
		if (!cmd) continue;
		if (/\bgit\s+push\b/.test(cmd)) {
			return { kind: "irreversible", detail: `git push: ${cmd.slice(0, 80)}` };
		}
		if (/\brm\s+-rf?\b/.test(cmd)) {
			return { kind: "irreversible", detail: `rm -rf: ${cmd.slice(0, 80)}` };
		}
		if (/\bnpm\s+(install|i)\s+/.test(cmd) && !/\bnpm\s+(test|run|ci|ls)\b/.test(cmd)) {
			return { kind: "irreversible", detail: `npm install: ${cmd.slice(0, 80)}` };
		}
	}

	// 3. Binary choice phrasing in final text
	const choicePattern =
		/要不.+要不|或者.+或者|派.+派|要不要派|派哪个|该.+还是|do you want|should I|which one/i;
	if (choicePattern.test(text)) {
		return { kind: "binary-choice", detail: "final text proposed a binary choice" };
	}

	// 3b. Modern UI menu options — catches lettered/slash/verb patterns the
	//     original regex missed (e.g. "(a) / (b) / (c)" option lists).
	if (looksLikeMenuOptions(text)) {
		return { kind: "binary-choice", detail: "modern UI options menu (lettered/slash/verb)" };
	}

	return null;
}

/**
 * Did this specific assistant message contain a jev shell call?
 * Used both for event.message on turn_end and for the message_end tracker.
 */
function ranJevInMessage(message: AssistantLike): boolean {
	const toolCalls = getToolCalls(message);
	return toolCalls.some((tc) => {
		const cmd = getBashCommand(tc);
		return cmd !== null && cmd.includes(JEV_SHELL_MARKER);
	});
}

// ---- Extension ----

export default function jevCheckExtension(pi: ExtensionAPI) {
	let nudgeCount = 0;
	let jevRanThisTurn = false;
	let executionHappenedThisTurn = false;

	pi.on("session_start", () => {
		nudgeCount = 0;
		jevRanThisTurn = false;
		executionHappenedThisTurn = false;
	});

	// Reset per-turn trackers at every turn boundary.
	pi.on("turn_start", () => {
		jevRanThisTurn = false;
		executionHappenedThisTurn = false;
	});

	// Track BOTH jev runs AND non-jev execution across ALL assistant messages
	// in the current turn (event.message on turn_end is only the LAST assistant
	// message — without these trackers, jev runs / dispatches in earlier
	// messages would be missed).
	pi.on("message_end", (event) => {
		if (!isAssistant(event.message)) return;
		if (ranJevInMessage(event.message)) {
			jevRanThisTurn = true;
		}
		if (hasNonJevToolCall(event.message)) {
			executionHappenedThisTurn = true;
		}
	});

	pi.on("turn_end", async (event) => {
		if (!isAssistant(event.message)) return;

		const jevRan = jevRanThisTurn || ranJevInMessage(event.message);
		const executed = executionHappenedThisTurn || hasNonJevToolCall(event.message);

		// Reset compliance counter on jev run (still do this — jev IS the right
		// signal; we just want to ALSO catch the "jev ran but didn't execute"
		// anti-pattern below).
		if (jevRan) {
			nudgeCount = 0;
		}

		// Always reset per-turn trackers (regardless of nudge path).
		jevRanThisTurn = false;
		executionHappenedThisTurn = false;

		// Path 1: jev ran AND model executed → no nudge (model followed through
		// on the jev signal — even if final text contains options menu).
		if (jevRan && executed) return;

		const signal = detectDecision(event.message);
		if (!signal) return;

		// Cap nudges to avoid infinite loops
		if (nudgeCount >= MAX_NUDGES) return;

		nudgeCount++;

		// Path 2 (post-jev slip): jev ran but model didn't execute and still
		// presented options. Different message: "you ran jev, why didn't you
		// execute on its signal?"
		if (jevRan) {
			const postJevReminder =
				`[jev-check · post-jev nudge ${nudgeCount}/${MAX_NUDGES}] ` +
				`你跑了 jev 但没执行。` +
				`MEMORY §"Jev 使用方法论": "conf ≥ 0.7 + majority 明显 → 直接执行"。` +
				`当前轮: ${signal.detail}。` +
				`请立刻执行 — 报 jev 信号 + 执行进度, 不要再次问 user。` +
				`若 jev 信号确实需要 user 拍板 (conf < 0.4), 显式声明 "no-exec: <reason>"。`;

			return {
				entries: [
					{
						type: "custom_message",
						customType: "jev-reminder",
						content: postJevReminder,
						display: false,
					},
				],
				continue: true,
			};
		}

		// Path 3 (pre-jev miss): dispatch / irreversible / binary choice
		// without first running jev. Existing behavior.
		const preJevReminder =
			`[jev-check · pre-jev nudge ${nudgeCount}/${MAX_NUDGES}] ` +
			`你刚才 ${signal.detail} 但本轮没跑 jev。` +
			`按 MEMORY 偏好("任何选择题先跑 jev, 不问 user"),` +
			`任何 dispatch worker / 不可逆操作 / 二选一之前必须先跑 jev:\n\n` +
			`  bash ~/.pi/skills/jev/scripts/jev.sh ask \\\n` +
			`    --state "<5 段 state: 现状/选项/依赖/历史信号/risk>" \\\n` +
			`    --choice 'id=question|optA=descA|optB=descB|optC=descC' \\\n` +
			`    --noul 'id=yes/no question'\n\n` +
			`跑完 jev 后, conf ≥ 0.7 直接执行, conf < 0.4 才问 user。` +
			`如果确定不需要 jev (例如: trivial action), 显式声明 "no-jev: <reason>" 即可跳过。`;

		return {
			entries: [
				{
					type: "custom_message",
					customType: "jev-reminder",
					content: preJevReminder,
					display: false,
				},
			],
			continue: true,
		};
	});
}
