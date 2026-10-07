import type {
	Actor,
	ProcessToolApprovalDestination,
	ProcessToolApprovalRequest,
	ToolApprovalStatus,
} from "@leitwerk-dev/domain";
import { and, asc, eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { generateId, now, parsePersistedJson } from "./repo-helpers.js";
import * as s from "./schema.js";

function map(row: typeof s.processToolApprovalRequests.$inferSelect): ProcessToolApprovalRequest {
	return {
		id: row.id,
		instanceId: row.instanceId,
		turnRecordId: row.turnRecordId,
		toolCallId: row.toolCallId,
		toolName: row.toolName,
		arguments: parsePersistedJson<Record<string, unknown>>(
			row.argumentsJson,
			"tool approval arguments",
		),
		destination: row.destinationJson
			? parsePersistedJson<ProcessToolApprovalDestination>(
					row.destinationJson,
					"tool approval destination",
				)
			: null,
		status: row.status as ToolApprovalStatus,
		requestedAt: row.requestedAt,
		resolvedAt: row.resolvedAt,
		resolvedBy: row.resolvedByJson
			? parsePersistedJson<Actor>(row.resolvedByJson, "tool approval actor")
			: null,
		feedback: row.feedback,
	};
}

/** @internal */
export function createProcessToolApprovalRequestRepo(db: LeitwerkDb) {
	const list = (instanceId?: string, openOnly = false): ProcessToolApprovalRequest[] => {
		const filters = [
			...(instanceId ? [eq(s.processToolApprovalRequests.instanceId, instanceId)] : []),
			...(openOnly ? [eq(s.processToolApprovalRequests.status, "open")] : []),
		];
		return db
			.select()
			.from(s.processToolApprovalRequests)
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(asc(s.processToolApprovalRequests.requestedAt))
			.all()
			.map(map);
	};
	return {
		/** @internal */
		listByInstance: (instanceId: string) => list(instanceId),
		/** @internal */
		listOpen: (instanceId?: string) => list(instanceId, true),
		/** @internal */
		createIdempotent(input: {
			/** @internal */
			instanceId: string;
			/** @internal */
			turnRecordId: string;
			/** @internal */
			toolCallId: string;
			/** @internal */
			toolName: string;
			/** @internal */
			arguments: Record<string, unknown>;
			/** @internal */
			destination?: ProcessToolApprovalDestination;
			/** @internal */
			requestedAt?: string;
		}): {
			/** @internal */
			kind: "created" | "replay";
			/** @internal */
			request: ProcessToolApprovalRequest;
		} {
			const existing = db
				.select()
				.from(s.processToolApprovalRequests)
				.where(
					and(
						eq(s.processToolApprovalRequests.instanceId, input.instanceId),
						eq(s.processToolApprovalRequests.turnRecordId, input.turnRecordId),
						eq(s.processToolApprovalRequests.toolCallId, input.toolCallId),
					),
				)
				.get();
			if (existing) {
				const request = map(existing);
				if (
					request.toolName !== input.toolName ||
					JSON.stringify(request.arguments) !== JSON.stringify(input.arguments) ||
					JSON.stringify(request.destination) !== JSON.stringify(input.destination ?? null)
				) {
					throw new Error("Tool approval correlation was replayed with different arguments");
				}
				return { kind: "replay", request };
			}
			const row = db
				.insert(s.processToolApprovalRequests)
				.values({
					id: generateId("tap"),
					instanceId: input.instanceId,
					turnRecordId: input.turnRecordId,
					toolCallId: input.toolCallId,
					toolName: input.toolName,
					argumentsJson: JSON.stringify(input.arguments),
					destinationJson: input.destination ? JSON.stringify(input.destination) : null,
					requestedAt: input.requestedAt ?? now(),
				})
				.returning()
				.get();
			return { kind: "created", request: map(row) };
		},
		/** @internal */
		resolve(input: {
			/** @internal */
			id: string;
			/** @internal */
			status: Exclude<ToolApprovalStatus, "open" | "cancelled">;
			/** @internal */
			actor: Actor;
			/** @internal */
			feedback?: string;
			/** @internal */
			resolvedAt?: string;
		}): ProcessToolApprovalRequest | null {
			if (input.status === "feedback" && !input.feedback?.trim())
				throw new Error("Feedback is required");
			const row = db
				.update(s.processToolApprovalRequests)
				.set({
					status: input.status,
					resolvedAt: input.resolvedAt ?? now(),
					resolvedByJson: JSON.stringify(input.actor),
					feedback: input.feedback?.trim() ?? null,
				})
				.where(
					and(
						eq(s.processToolApprovalRequests.id, input.id),
						eq(s.processToolApprovalRequests.status, "open"),
					),
				)
				.returning()
				.get();
			return row ? map(row) : null;
		},
		/** @internal */
		cancelOpenByTurn(instanceId: string, turnRecordId: string): number {
			const result = db
				.update(s.processToolApprovalRequests)
				.set({ status: "cancelled", resolvedAt: now() })
				.where(
					and(
						eq(s.processToolApprovalRequests.instanceId, instanceId),
						eq(s.processToolApprovalRequests.turnRecordId, turnRecordId),
						eq(s.processToolApprovalRequests.status, "open"),
					),
				)
				.run();
			return Number(result.changes);
		},
	};
}
