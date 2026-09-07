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

export function createToolApprovalGate(input: {
	repos: Pick<RepositoryBundle, "toolApprovalRequests" | "transaction">;
	processOperations: ProcessOperationCoordinator;
}) {
	const waiters = new Map<string, Set<(decision: ToolApprovalDecision) => void>>();
	return {
		async review(requestInput: {
			instanceId: string;
			turnRecordId: string;
			toolCallId: string;
			toolName: string;
			arguments: Record<string, unknown>;
			destination?: ProcessToolApprovalDestination;
		}): Promise<ToolApprovalDecision> {
			const result = input.repos.toolApprovalRequests.createIdempotent(requestInput);
			if (result.request.status === "accepted") return { kind: "accepted" };
			if (result.request.status === "feedback")
				return { kind: "feedback", feedback: result.request.feedback ?? "" };
			if (result.request.status === "declined" || result.request.status === "cancelled")
				return { kind: "declined" };
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
			return input.processOperations.runExclusive(instanceId, () =>
				input.repos.transaction((repos) => {
					const open = repos.toolApprovalRequests
						.listOpen(instanceId)
						.find((candidate) => candidate.id === requestId);
					if (!open) return null;
					const resolved = repos.toolApprovalRequests.resolve({
						id: requestId,
						status: decision.kind,
						actor,
						...(decision.kind === "feedback" ? { feedback: decision.feedback } : {}),
					});
					if (resolved) {
						for (const resolve of waiters.get(requestId) ?? []) resolve(decision);
						waiters.delete(requestId);
					}
					return resolved;
				}),
			);
		},
		cancelTurn(instanceId: string, turnRecordId: string): number {
			const open = input.repos.toolApprovalRequests
				.listOpen(instanceId)
				.filter((request) => request.turnRecordId === turnRecordId);
			const changed = input.repos.toolApprovalRequests.cancelOpenByTurn(instanceId, turnRecordId);
			for (const request of open) {
				for (const resolve of waiters.get(request.id) ?? []) resolve({ kind: "declined" });
				waiters.delete(request.id);
			}
			return changed;
		},
	};
}
export type ToolApprovalGate = ReturnType<typeof createToolApprovalGate>;
