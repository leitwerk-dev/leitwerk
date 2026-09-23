import type {
	MappedTurnItemRef,
	ProcessInstance,
	ProcessProject,
	TurnOutcomePayload,
} from "@leitwerk-dev/domain";
import {
	collectMappedResults,
	freezeMappedItems,
	type MappedLlmTurnSpec,
	type MappedTurnServerContext,
	SafeOutcomePlanningError,
	yieldMappedItemResult,
} from "@leitwerk-dev/process-sdk";
import { generateId } from "../db/repo-helpers.js";
import type { RepositoryBundle } from "../db/repositories.js";
import type { ProcessActionRegistry } from "../process-action-registry.js";
import type { ProcessGraphRegistry } from "../process-graph.js";
import { buildServerTransitionWrites } from "./writes/build-server-transition-writes.js";
import {
	appendProcessEvent,
	applyProcessPatchField,
	createWrites,
	isWriteBuildFailure,
	mergeWrites,
	type WriteBuildFailure,
	type WriteBuildResult,
	type Writes,
} from "./writes/writes.js";

type MappedRunRepo = RepositoryBundle["mappedRuns"];
type Registry = Pick<ProcessActionRegistry, "getTurnDefinition" | "resolveContextData">;

/** Bounds consecutive empty mapped turns routed within one decision. */
const MAX_EMPTY_MAPPED_ENTRIES = 16;

/** @internal */
export function getMappedTurnSpec(
	registry: Pick<ProcessActionRegistry, "getTurnDefinition"> | undefined,
	processId: string,
	turnId: string | null,
): MappedLlmTurnSpec | undefined {
	if (!registry || !turnId) return undefined;
	const turn = registry.getTurnDefinition(processId, turnId);
	return turn?.kind === "llm" ? turn.forEach : undefined;
}

function failure(code: string, message: string): WriteBuildFailure {
	return { ok: false, code, message };
}

function planningFailure(error: unknown, code: string): WriteBuildFailure {
	if (error instanceof SafeOutcomePlanningError) return failure(error.code, error.message);
	throw error instanceof Error ? error : new Error(`${code}: ${String(error)}`);
}

function serverContext(
	registry: Registry,
	process: ProcessInstance,
	projects: readonly ProcessProject[],
): MappedTurnServerContext {
	const { params, state } = registry.resolveContextData(process.processId, process);
	return { process, projects, params, state };
}

function appendInto(target: Writes, source: Writes): void {
	Object.assign(target, mergeWrites(target, source));
}

function reserveItemStart(
	writes: Writes,
	process: ProcessInstance,
	turnId: string,
	iteration: MappedTurnItemRef,
): void {
	const startId = generateId("tsr");
	writes.turnStartWrites.push({
		kind: "create",
		input: {
			id: startId,
			instanceId: process.id,
			turnId,
			turnType: "llm",
			proposedTurnRecordId: generateId("trn"),
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: {
				kind: "preparation_failed",
				requestedModelProfileId: process.selectedTurnModelProfileId ?? null,
				providerOptions: {},
				code: "model_required",
				safeSummary: "LLM start requires model preflight",
			},
			iteration,
		},
	});
	applyProcessPatchField(writes, process, "currentExecution", {
		kind: "worker_start",
		id: startId,
	});
	// Model preflight activates the start and restarts the worker on success.
	applyProcessPatchField(writes, process, "lifecycleStatus", "error");
	writes.workerIntent = { kind: "reconcile" };
}

async function collectAndRoute(input: {
	processGraphs: ProcessGraphRegistry;
	process: ProcessInstance;
	ctx: MappedTurnServerContext;
	spec: MappedLlmTurnSpec;
	turnId: string;
	runId: string;
	resultJsons: readonly string[];
}): Promise<WriteBuildResult> {
	let collected: Awaited<ReturnType<typeof collectMappedResults>>;
	try {
		collected = await collectMappedResults({
			turnId: input.turnId,
			spec: input.spec,
			ctx: input.ctx,
			resultJsons: input.resultJsons,
		});
	} catch (error) {
		return planningFailure(error, "mapped_collect_failed");
	}
	const writes = buildServerTransitionWrites(input.processGraphs, input.process, {
		turnId: collected.route.nextTurnId ?? null,
		...(collected.route.lifecycleStatus
			? { lifecycleStatus: collected.route.lifecycleStatus }
			: {}),
		trigger: collected.route.trigger,
		state: collected.state,
	});
	if (isWriteBuildFailure(writes)) return writes;
	appendProcessEvent(writes, input.process, {
		eventType: "mapped_run_collected",
		level: "info",
		message: `Collected ${input.resultJsons.length} result(s) for ${input.turnId}`,
		data: {
			runId: input.runId,
			turnId: input.turnId,
			itemCount: input.resultJsons.length,
			trigger: collected.route.trigger,
		},
	});
	return writes;
}

/**
 * Freezes items for every newly selected mapped turn in `writes`, before model
 * preflight. A non-empty run reserves only its first item; an empty run collects
 * and routes immediately. Leaving a mapped turn by any other route aborts its run.
 * @internal
 */
export async function planMappedTurnEntries(input: {
	processGraphs: ProcessGraphRegistry;
	registry: Registry | undefined;
	mappedRuns: MappedRunRepo | undefined;
	projects: Pick<RepositoryBundle["projects"], "listByInstance">;
	process: ProcessInstance;
	writes: Writes;
}): Promise<{ ok: true } | WriteBuildFailure> {
	const { writes } = input;
	const active = input.mappedRuns?.getActiveByInstance(input.process.id) ?? null;
	let activeAborted = false;
	for (let entry = 0; entry <= MAX_EMPTY_MAPPED_ENTRIES; entry += 1) {
		const candidate: ProcessInstance = { ...input.process, ...writes.processPatch };
		const startIndex = writes.turnStartWrites.findIndex(
			(write) =>
				write.kind === "create" &&
				write.input.turnType === "llm" &&
				write.input.startKind === "selected_turn" &&
				!write.input.iteration &&
				write.input.turnId === candidate.selectedTurnId,
		);
		const start = startIndex >= 0 ? writes.turnStartWrites[startIndex] : undefined;
		const spec =
			start?.kind === "create"
				? getMappedTurnSpec(input.registry, candidate.processId, start.input.turnId)
				: undefined;
		if (!start || start.kind !== "create" || !spec || !input.registry) {
			const leavesActiveRun =
				active !== null &&
				!activeAborted &&
				!writes.mappedRunWrites.some((write) => write.kind === "complete_item") &&
				(candidate.selectedTurnId !== active.turnId ||
					candidate.lifecycleStatus === "completed" ||
					candidate.lifecycleStatus === "aborted");
			if (leavesActiveRun) writes.mappedRunWrites.push({ kind: "abort_active" });
			return { ok: true };
		}
		if (entry === MAX_EMPTY_MAPPED_ENTRIES) {
			return failure("mapped_turn_loop", "Too many consecutive empty mapped turns");
		}
		if (!input.mappedRuns) {
			return failure("mapped_runs_unavailable", "Mapped turn storage is not available");
		}
		if (active && !activeAborted) {
			writes.mappedRunWrites.push({ kind: "abort_active" });
			activeAborted = true;
		}
		const turnId = start.input.turnId;
		const projects = input.projects.listByInstance(input.process.id);
		let ctx = serverContext(input.registry, candidate, projects);
		let frozen: ReturnType<typeof freezeMappedItems>;
		try {
			frozen = freezeMappedItems(turnId, spec, ctx);
		} catch (error) {
			return planningFailure(error, "invalid_mapped_items");
		}
		const runId = generateId("mlr");
		writes.mappedRunWrites.push({
			kind: "create",
			input: {
				id: runId,
				instanceId: input.process.id,
				turnId,
				status: frozen.items.length > 0 ? "active" : "completed",
				items: frozen.items.map((item) => ({
					itemIndex: item.index,
					itemKey: item.key,
					label: item.label,
					itemJson: item.itemJson,
				})),
			},
		});
		appendProcessEvent(writes, candidate, {
			eventType: "mapped_run_started",
			level: "info",
			message: `Froze ${frozen.items.length} item(s) for ${turnId}`,
			data: { runId, turnId, itemCount: frozen.items.length },
		});
		if (frozen.state !== undefined) {
			applyProcessPatchField(writes, candidate, "stateJson", JSON.stringify(frozen.state));
			ctx = { ...ctx, state: frozen.state };
		}
		const first = frozen.items[0];
		if (first) {
			start.input.iteration = { runId, itemKey: first.key, itemIndex: 0 };
			return { ok: true };
		}
		writes.turnStartWrites.splice(startIndex, 1);
		const routed = await collectAndRoute({
			processGraphs: input.processGraphs,
			process: { ...input.process, ...writes.processPatch },
			ctx,
			spec,
			turnId,
			runId,
			resultJsons: [],
		});
		if (isWriteBuildFailure(routed)) return routed;
		appendInto(writes, routed);
	}
	return failure("mapped_turn_loop", "Too many consecutive empty mapped turns");
}

/**
 * Records one item's validated result. Reserves the next item's start, or,
 * after the last item, collects all results in order and applies the single
 * collection route.
 * @internal
 */
export async function buildMappedItemOutcomeWrites(input: {
	processGraphs: ProcessGraphRegistry;
	registry: Registry;
	mappedRuns: MappedRunRepo | undefined;
	process: ProcessInstance;
	projects: readonly ProcessProject[];
	payload: TurnOutcomePayload;
	spec: MappedLlmTurnSpec;
	iteration: MappedTurnItemRef | null | undefined;
	prepared?: unknown;
}): Promise<WriteBuildResult> {
	const { payload, iteration } = input;
	if (!input.mappedRuns) {
		return failure("mapped_runs_unavailable", "Mapped turn storage is not available");
	}
	if (!iteration) {
		return failure("mapped_item_missing", `Turn '${payload.turnId}' has no active mapped item`);
	}
	const run = input.mappedRuns.getById(iteration.runId);
	const item = input.mappedRuns.getItem(iteration.runId, iteration.itemIndex);
	if (
		!run ||
		!item ||
		run.status !== "active" ||
		run.turnId !== payload.turnId ||
		run.nextIndex !== iteration.itemIndex ||
		item.itemKey !== iteration.itemKey ||
		item.status !== "pending"
	) {
		return failure(
			"stale_mapped_item",
			`Mapped item '${iteration.itemKey}' is no longer the current item of '${payload.turnId}'`,
		);
	}
	const ctx = serverContext(input.registry, input.process, input.projects);
	let resultJson: string;
	try {
		resultJson = await yieldMappedItemResult({
			turnId: payload.turnId,
			spec: input.spec,
			ctx,
			iteration: {
				runId: run.id,
				itemKey: item.itemKey,
				itemLabel: item.label,
				itemIndex: item.itemIndex,
				itemCount: run.itemCount,
				item: JSON.parse(item.itemJson) as unknown,
			},
			event: {
				turnRecordId: payload.turnRecordId,
				turnId: payload.turnId,
				outcome: payload.outcome,
				params: payload.params ?? {},
				turnResultMarkdown: payload.turnResultMarkdown ?? null,
				...(input.prepared !== undefined ? { prepared: input.prepared } : {}),
			},
		});
	} catch (error) {
		return planningFailure(error, "invalid_mapped_result");
	}
	const writes = createWrites();
	writes.mappedRunWrites.push({
		kind: "complete_item",
		input: {
			runId: run.id,
			itemIndex: item.itemIndex,
			outcome: payload.outcome,
			resultJson,
			turnRecordId: payload.turnRecordId,
		},
	});
	const nextIndex = item.itemIndex + 1;
	if (nextIndex < run.itemCount) {
		const next = input.mappedRuns.getItem(run.id, nextIndex);
		if (!next) return failure("stale_mapped_item", `Mapped run '${run.id}' lost item ${nextIndex}`);
		reserveItemStart(writes, input.process, payload.turnId, {
			runId: run.id,
			itemKey: next.itemKey,
			itemIndex: nextIndex,
		});
		return writes;
	}
	const resultJsons = input.mappedRuns
		.listItems(run.id)
		.map((stored) => (stored.itemIndex === item.itemIndex ? resultJson : stored.resultJson));
	if (resultJsons.some((json) => json === null)) {
		return failure("stale_mapped_item", `Mapped run '${run.id}' is missing item results`);
	}
	const routed = await collectAndRoute({
		processGraphs: input.processGraphs,
		process: input.process,
		ctx,
		spec: input.spec,
		turnId: payload.turnId,
		runId: run.id,
		resultJsons: resultJsons as string[],
	});
	if (isWriteBuildFailure(routed)) return routed;
	return mergeWrites(writes, routed);
}
