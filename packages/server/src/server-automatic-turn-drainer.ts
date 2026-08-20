import type { ProcessInstance, ProcessTurnRecord, TurnProgressReport } from "@leitwerk-dev/domain";
import { isServerAutomaticTurnDefinition } from "@leitwerk-dev/process-sdk";
import type { EngineResult, ProcessEngine, ProcessEngineDeps } from "./process-engine/types.js";
import { resolveProductTurnResultMarkdown } from "./product-turn-result-markdown.js";
import { resolveSemanticTurnResultMarkdown } from "./semantic-turn-result-markdown.js";
import { recordTurnProgress } from "./turn-progress.js";

export interface ServerAutomaticTurnDrainer {
	requestDrain(instanceId: string, options?: { freshTurnRecordId?: string | null }): Promise<void>;
}

export interface ServerAutomaticTurnDrainerService {
	recordTurnOutcome(
		instanceId: string,
		payload: Parameters<ProcessEngine["recordTurnOutcome"]>[1],
	): Promise<EngineResult<void>>;
	recordTurnFailed(
		instanceId: string,
		payload: Parameters<ProcessEngine["recordTurnFailed"]>[1],
	): Promise<EngineResult<void>>;
	parkProcessLifecycle(
		instanceId: string,
		payload: Parameters<ProcessEngine["parkProcessLifecycle"]>[1],
	): Promise<EngineResult<void>>;
}

function toErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message.trim() !== "") {
		return error.message;
	}
	return String(error);
}

function isSelectedServerAutomaticTurn(
	deps: ProcessEngineDeps,
	process: Pick<ProcessInstance, "processId" | "selectedTurnId" | "lifecycleStatus">,
): boolean {
	if (!process.selectedTurnId || process.lifecycleStatus !== "active") {
		return false;
	}
	const turnDef = deps
		.getProcessActionRegistry?.()
		?.getTurnDefinition(process.processId, process.selectedTurnId);
	return !!turnDef && isServerAutomaticTurnDefinition(turnDef);
}

function resolveTurnMarkdownForServerAutomatic(
	deps: ProcessEngineDeps,
	process: ProcessInstance,
	ref: Parameters<typeof resolveSemanticTurnResultMarkdown>[0]["semanticEntryRefKey"],
): string | null {
	return resolveSemanticTurnResultMarkdown({
		process,
		semanticEntryRefKey: ref,
		turnRecords: deps.turnRecords,
		required: false,
	});
}

function resolveProductMarkdownForServerAutomatic(
	deps: ProcessEngineDeps,
	process: ProcessInstance,
	productName: string,
): string | null {
	return resolveProductTurnResultMarkdown({
		process,
		productName,
		turnRecords: deps.turnRecords,
		required: false,
	});
}

function resolveReusableRunningServerAutomaticTurnRecord(input: {
	process: ProcessInstance;
	turnId: string;
	turnRecord: ProcessTurnRecord | null;
}): ProcessTurnRecord | null {
	const { process, turnId, turnRecord } = input;
	const activeTurnRecordId =
		process.currentExecution?.kind === "server_turn" ? process.currentExecution.id : null;
	if (!activeTurnRecordId) {
		return null;
	}
	if (
		turnRecord &&
		turnRecord.instanceId === process.id &&
		turnRecord.id === activeTurnRecordId &&
		turnRecord.turnId === turnId &&
		turnRecord.turnType === "server_automatic" &&
		turnRecord.status === "running"
	) {
		return turnRecord;
	}
	return null;
}

function describeInvalidRunningServerAutomaticTurnRecord(input: {
	process: ProcessInstance;
	turnId: string;
	turnRecord: ProcessTurnRecord | null;
}): string {
	const pointer =
		(input.process.currentExecution?.kind === "server_turn"
			? input.process.currentExecution.id
			: null) ?? "<none>";
	if (!input.turnRecord) {
		return `Cannot resume server-automatic turn '${input.turnId}': current execution '${pointer}' does not reference a durable turn record`;
	}
	return `Cannot resume server-automatic turn '${input.turnId}': current execution '${pointer}' references ${input.turnRecord.status} ${input.turnRecord.turnType} turn '${input.turnRecord.turnId}' for process '${input.turnRecord.instanceId}'`;
}

const OUTCOME_REJECTION_CODES_THAT_DO_NOT_FAIL_TURN = new Set([
	"process_not_found",
	"stale_turn",
	"stale_turn_record",
	"turn_unavailable_for_selected_turn",
]);

function shouldRecordFailureForRejectedOutcome(result: EngineResult<void>): boolean {
	if (result.ok) {
		return false;
	}
	if (result.stage === "post_commit") {
		return false;
	}
	return !OUTCOME_REJECTION_CODES_THAT_DO_NOT_FAIL_TURN.has(result.code);
}

export function createServerAutomaticTurnDrainer(
	deps: ProcessEngineDeps,
	getService: () => ServerAutomaticTurnDrainerService,
): ServerAutomaticTurnDrainer {
	const drainRequests = new Map<
		string,
		{ requested: boolean; freshTurnRecordIds: Set<string>; promise: Promise<void> }
	>();

	async function drainServerAutomaticTurns(
		instanceId: string,
		freshTurnRecordIds: Set<string>,
	): Promise<void> {
		const service = getService();
		for (;;) {
			const process = deps.processes.getById(instanceId);
			if (!process || !isSelectedServerAutomaticTurn(deps, process)) {
				return;
			}
			const turnId = process.selectedTurnId;
			if (!turnId) {
				return;
			}
			const turnDef = deps
				.getProcessActionRegistry?.()
				?.getTurnDefinition(process.processId, turnId);
			if (!turnDef || !isServerAutomaticTurnDefinition(turnDef)) {
				return;
			}
			let turnRecordId: string;
			let pathType: ProcessTurnRecord["pathType"] = "primary";
			const activeTurnRecordId =
				process.currentExecution?.kind === "server_turn" ? process.currentExecution.id : null;
			const currentTurnRecord = activeTurnRecordId
				? deps.turnRecords.getById(activeTurnRecordId)
				: null;
			const runningTurnRecord = activeTurnRecordId
				? resolveReusableRunningServerAutomaticTurnRecord({
						process,
						turnId,
						turnRecord: currentTurnRecord,
					})
				: null;
			if (activeTurnRecordId) {
				if (!runningTurnRecord) {
					await service.parkProcessLifecycle(instanceId, {
						selectedTurnId: turnId,
						reason: describeInvalidRunningServerAutomaticTurnRecord({
							process,
							turnId,
							turnRecord: currentTurnRecord,
						}),
						errorClass: "infrastructure",
					});
					return;
				}
				turnRecordId = runningTurnRecord.id;
				pathType = runningTurnRecord.pathType;
				const isFreshTurn = freshTurnRecordIds.delete(turnRecordId);
				if (!isFreshTurn && turnDef.restartBehavior === "fail_running") {
					await service.recordTurnFailed(instanceId, {
						instanceId,
						turnRecordId,
						turnId,
						turnType: "server_automatic",
						pathType,
						errorSummary:
							"Server-automatic turn was interrupted before completion and is configured not to rerun automatically",
						errorClass: "infrastructure",
					});
					return;
				}
			} else {
				await service.parkProcessLifecycle(instanceId, {
					selectedTurnId: turnId,
					reason: "Server-automatic turn is missing its current server-turn execution",
					errorClass: "infrastructure",
				});
				return;
			}
			const current = deps.processes.getById(instanceId) ?? process;
			const { params, state } = deps
				.getProcessActionRegistry?.()
				?.resolveContextData(current.processId, current) ?? { params: {}, state: {} };
			let latestProgressReport: TurnProgressReport | null = null;
			try {
				const result = await turnDef.run({
					process: current,
					projects: deps.projects.listByInstance(instanceId),
					params,
					state,
					readSemanticTurnResultMarkdown(ref) {
						return resolveTurnMarkdownForServerAutomatic(deps, current, ref);
					},
					readProductTurnResultMarkdown(productName) {
						return resolveProductMarkdownForServerAutomatic(deps, current, productName);
					},
					reportProgress(report) {
						latestProgressReport = report;
						recordTurnProgress(deps, { instanceId, turnRecordId, report });
					},
				});
				const recorded = await service.recordTurnOutcome(instanceId, {
					instanceId,
					turnRecordId,
					turnId,
					turnType: "server_automatic",
					outcome: result.outcome,
					params: result.params ?? {},
					pathType,
					turnResultMarkdown: result.markdown ?? null,
					...(result.state !== undefined ? { state: result.state } : {}),
				});
				if (!recorded.ok) {
					if (shouldRecordFailureForRejectedOutcome(recorded)) {
						await service.recordTurnFailed(instanceId, {
							instanceId,
							turnRecordId,
							turnId,
							turnType: "server_automatic",
							pathType,
							errorSummary: recorded.message,
							errorClass: "infrastructure",
						});
					}
					return;
				}
			} catch (error) {
				const failedProgressReport = latestProgressReport as TurnProgressReport | null;
				if (failedProgressReport) {
					const message = toErrorMessage(error);
					const report: TurnProgressReport = {
						...failedProgressReport,
						steps: failedProgressReport.steps.map((step) =>
							step.status === "in_progress"
								? { ...step, status: "failed" as const, detail: message }
								: step,
						),
					};
					recordTurnProgress(deps, { instanceId, turnRecordId, report });
				}
				await service.recordTurnFailed(instanceId, {
					instanceId,
					turnRecordId,
					turnId,
					turnType: "server_automatic",
					pathType,
					errorSummary: toErrorMessage(error),
					errorClass: "infrastructure",
				});
				return;
			}
		}
	}

	return {
		async requestDrain(instanceId, options = {}) {
			const existing = drainRequests.get(instanceId);
			if (existing) {
				existing.requested = true;
				if (options.freshTurnRecordId) {
					existing.freshTurnRecordIds.add(options.freshTurnRecordId);
				}
				return existing.promise;
			}
			const request = {
				requested: true,
				freshTurnRecordIds: new Set<string>(),
				promise: Promise.resolve(),
			};
			if (options.freshTurnRecordId) {
				request.freshTurnRecordIds.add(options.freshTurnRecordId);
			}
			drainRequests.set(instanceId, request);
			request.promise = (async () => {
				try {
					while (request.requested) {
						request.requested = false;
						await drainServerAutomaticTurns(instanceId, request.freshTurnRecordIds);
					}
				} finally {
					drainRequests.delete(instanceId);
				}
			})();
			return request.promise;
		},
	};
}
