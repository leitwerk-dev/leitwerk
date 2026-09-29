import { createHash } from "node:crypto";
import type {
	ExecutionInspectionCapture,
	ExecutionInspectionRecord,
	InspectionContextObservation,
} from "@leitwerk-dev/domain";
import type { InspectionConfigurationRevision } from "@leitwerk-dev/protocol";
import { and, asc, eq, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { executionInspections, inspectionContents } from "./schema.js";

/** Immutable content and incremental observation references. No session ancestry is copied. @internal */
export function createExecutionInspectionRepo(db: LeitwerkDb) {
	function pack(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(pack);
		if (!value || typeof value !== "object") return value;
		const record = value as Record<string, unknown>;
		if ((record.state === "recorded" || record.state === "redacted") && "value" in record) {
			const contentJson = JSON.stringify(record.value);
			const digest = createHash("sha256").update(contentJson).digest("hex");
			db.insert(inspectionContents).values({ digest, contentJson }).onConflictDoNothing().run();
			return { state: record.state, contentDigest: digest };
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, pack(item)]));
	}
	function unpack(value: unknown): unknown {
		if (Array.isArray(value)) return value.map(unpack);
		if (!value || typeof value !== "object") return value;
		const record = value as Record<string, unknown>;
		if (typeof record.contentDigest === "string") {
			const row = db
				.select()
				.from(inspectionContents)
				.where(eq(inspectionContents.digest, record.contentDigest))
				.get();
			return row
				? { state: record.state, value: JSON.parse(row.contentJson) }
				: { state: "unavailable", reason: "Recorded content is unavailable" };
		}
		return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, unpack(item)]));
	}
	return {
		/** Model identities without loading retained prompts or message contents. @internal */
		modelInputs(
			instanceId: string,
			turnRecordId: string,
		): Pick<InspectionConfigurationRevision, "id" | "timestamp" | "boundaryEntryId" | "model">[] {
			return db
				.select({
					id: executionInspections.id,
					timestamp: executionInspections.capturedAt,
					boundaryEntryId: sql<
						string | null
					>`json_extract(${executionInspections.factJson}, '$.boundaryEntryId')`,
					model: sql<string>`json_extract(${executionInspections.factJson}, '$.model')`,
				})
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						eq(executionInspections.turnRecordId, turnRecordId),
						sql`json_extract(${executionInspections.factJson}, '$.kind') = 'model_input'`,
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all()
				.map((row) => ({
					...row,
					model: JSON.parse(row.model) as InspectionConfigurationRevision["model"],
				}));
		},
		/** @internal */
		append(input: Omit<ExecutionInspectionRecord, "sequence">): "stored" | "replay" {
			return db.transaction(() => {
				const factJson = JSON.stringify(pack(input.fact));
				const existing = db
					.select()
					.from(executionInspections)
					.where(eq(executionInspections.id, input.id))
					.get();
				if (existing) {
					if (
						existing.instanceId !== input.instanceId ||
						existing.turnRecordId !== input.turnRecordId ||
						existing.factJson !== factJson
					)
						throw new Error("Inspection observation identity was reused with different evidence");
					return "replay";
				}
				db.insert(executionInspections)
					.values({
						id: input.id,
						instanceId: input.instanceId,
						turnRecordId: input.turnRecordId,
						startRecordId: input.startRecordId,
						workerLeaseId: input.workerLeaseId,
						capturedAt: input.timestamp,
						factJson,
					})
					.run();
				return "stored";
			});
		},
		/** Expanded evidence is read only on demand. @internal */
		list(instanceId: string, turnRecordId: string): ExecutionInspectionRecord[] {
			return db
				.select()
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						eq(executionInspections.turnRecordId, turnRecordId),
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all()
				.map((row) => ({
					version: 1,
					id: row.id,
					sequence: row.sequence,
					instanceId: row.instanceId,
					turnRecordId: row.turnRecordId,
					startRecordId: row.startRecordId,
					workerLeaseId: row.workerLeaseId,
					timestamp: row.capturedAt,
					fact: unpack(JSON.parse(row.factJson)) as ExecutionInspectionCapture["fact"],
				}));
		},
		/** Small origin/product references for compact lineage without loading prompts. @internal */
		listContextFacts(instanceId: string): InspectionContextObservation[] {
			return db
				.select()
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						sql`json_extract(${executionInspections.factJson}, '$.kind') IN ('supplied_context', 'product_consumed', 'entry_link')`,
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all()
				.flatMap((row) => {
					const fact = JSON.parse(row.factJson) as ExecutionInspectionCapture["fact"];
					if (
						fact.kind !== "supplied_context" &&
						fact.kind !== "product_consumed" &&
						fact.kind !== "entry_link"
					)
						return [];
					return [
						{
							id: row.id,
							turnRecordId: row.turnRecordId,
							fact:
								fact.kind === "supplied_context"
									? {
											...fact,
											products: fact.products.map(({ content: _content, ...source }) => source),
										}
									: fact,
						},
					];
				});
		},
	};
}
