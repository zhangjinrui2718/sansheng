/**
 * Empty Array Fix Extension
 *
 * Workaround for pi-coding-agent bug where empty arrays in tool call
 * arguments are stripped before reaching prepareArguments. This breaks
 * pi-subagent's delegate_task isolated mode (v5+), because the graph
 * validator requires a "source" node with empty dependsOn/contextFrom
 * arrays — every DAG must have at least one source node.
 *
 * This extension hooks `tool_call` events and re-injects empty arrays
 * for any tool whose JSON Schema declares an array field. Specifically
 * targeted at `delegate_task` for pi-subagent's isolated task graph.
 *
 * Without this fix, the user cannot express a 2+ task parallel isolated
 * graph (no source node possible) and many other pi-subagent use cases
 * that rely on empty-array semantics.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

interface TaskLike {
	id?: unknown;
	kind?: unknown;
	dependsOn?: unknown;
	contextFrom?: unknown;
	[key: string]: unknown;
}

interface DelegateTaskInput {
	mode?: unknown;
	tasks?: TaskLike[];
	chain?: unknown;
	[key: string]: unknown;
}

function isDelegateTaskInput(value: unknown): value is DelegateTaskInput {
	return typeof value === "object" && value !== null;
}

function isTaskArray(value: unknown): value is TaskLike[] {
	return Array.isArray(value);
}

export default function (pi: ExtensionAPI) {
	pi.on("tool_call", (event) => {
		if (event.toolName !== "delegate_task") return undefined;
		const input = event.input;
		if (!isDelegateTaskInput(input)) return undefined;

		// Isolated mode: input.tasks[] entries must have dependsOn + contextFrom arrays
		if (input.mode === "isolated" && isTaskArray(input.tasks)) {
			for (const task of input.tasks) {
				if (task === null || typeof task !== "object") continue;
				if (!Array.isArray(task.dependsOn)) {
					task.dependsOn = [];
				}
				if (!Array.isArray(task.contextFrom)) {
					task.contextFrom = [];
				}
			}
			return undefined;
		}

		// Direct mode with parallel tasks: same rule applies if tasks[] present
		if (isTaskArray(input.tasks)) {
			for (const task of input.tasks) {
				if (task === null || typeof task !== "object") continue;
				if (!Array.isArray(task.dependsOn)) {
					task.dependsOn = [];
				}
				if (!Array.isArray(task.contextFrom)) {
					task.contextFrom = [];
				}
			}
		}

		return undefined;
	});
}