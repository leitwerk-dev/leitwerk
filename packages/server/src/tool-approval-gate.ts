import type {
	Actor,
	ProcessToolApprovalDestination,
	ProcessToolApprovalRequest,
} from "@leitwerk-dev/domain";
import type { RepositoryBundle } from "./db/repositories.js";
import type { ProcessOperationCoordinator } from "./process-operation-coordinator.js";

export type ToolApprovalDecision =
	| { kind: "accepted" }
	| { kind: "feedback"; feedback: string }
	| { kind: "declined" };

type ToolApprovalRepos = Pick<
	RepositoryBundle,
	"processes" | "turnRecords" | "turnStarts" | "toolApprovalRequests" | "transaction"
>;

function isCurrentTurn(
	repos: ToolApprovalRepos,
	request: { instanceId: string; turnRecordId: string },
): boolean {
	const process = repos.processes.getById(request.instanceId);
	const turn = repos.turnRecords.getById(request.turnRecordId);
	const start =
		process?.currentExecution?.kind === "worker_start"
			? repos.turnStarts.getById(process.currentExecution.id)
			: null;
	return (
		process?.lifecycleStatus === "active" &&
		turn?.instanceId === request.instanceId &&
		turn.status === "running" &&
		process.selectedTurnId === turn.turnId &&
		start?.state.kind === "accepted" &&
		start.state.turnRecordId === request.turnRecordId
	);
}

function resolvedDecision(request: ProcessToolApprovalRequest): ToolApprovalDecision | null {
	if (request.status === "open") return null;
	if (request.status === "accepted") return { kind: "accepted" };
	if (request.status === "feedback") return { kind: "feedback", feedback: request.feedback ?? "" };
	return { kind: "declined" };
}

export function createToolApprovalGate(input: {
	repos: ToolApprovalRepos;
	processOperations: ProcessOperationCoordinator;
}) {
	const waiters = new Map<string, Set<(decision: ToolApprovalDecision) => void>>();
	function reconcile(instanceId: string): void {
		for (const request of input.repos.toolApprovalRequests.listByInstance(instanceId)) {
			const decision = resolvedDecision(request);
			if (!decision) continue;
			for (const resolve of waiters.get(request.id) ?? []) resolve(decision);
			waiters.delete(request.id);
		}
	}
	return {
		reconcile,
		async review(requestInput: {
			instanceId: string;
			turnRecordId: string;
			toolCallId: string;
			toolName: string;
			arguments: Record<string, unknown>;
			destination?: ProcessToolApprovalDestination;
		}): Promise<ToolApprovalDecision> {
			if (!isCurrentTurn(input.repos, requestInput)) return { kind: "declined" };
			const result = input.repos.toolApprovalRequests.createIdempotent(requestInput);
			const decision = resolvedDecision(result.request);
			if (decision) return decision;
			return await new Promise<ToolApprovalDecision>((resolve) => {
				const pending = waiters.get(result.request.id) ?? new Set();
				pending.add(resolve);
				waiters.set(result.request.id, pending);
			});
		},
		listOpen(instanceId?: string): ProcessToolApprovalRequest[] {
			return input.repos.toolApprovalRequests.listOpen(instanceId);
		},
		async resolve(
			instanceId: string,
			requestId: string,
			decision: ToolApprovalDecision,
			actor: Actor,
		) {
			const resolved = await input.processOperations.runExclusive(instanceId, () =>
				input.repos.transaction((repos) => {
					const open = repos.toolApprovalRequests
						.listOpen(instanceId)
						.find((candidate) => candidate.id === requestId);
					if (!open) return null;
					if (!isCurrentTurn(repos, open)) {
						repos.toolApprovalRequests.cancelOpenByTurn(instanceId, open.turnRecordId);
						return null;
					}
					return repos.toolApprovalRequests.resolve({
						id: requestId,
						status: decision.kind,
						actor,
						...(decision.kind === "feedback" ? { feedback: decision.feedback } : {}),
					});
				}),
			);
			reconcile(instanceId);
			return resolved;
		},
		cancelTurn(instanceId: string, turnRecordId: string): number {
			const changed = input.repos.toolApprovalRequests.cancelOpenByTurn(instanceId, turnRecordId);
			reconcile(instanceId);
			return changed;
		},
	};
}
export type ToolApprovalGate = ReturnType<typeof createToolApprovalGate>;
