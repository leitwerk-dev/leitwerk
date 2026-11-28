import { createHash } from "node:crypto";
import type {
	ExecutionInspectionCapture,
	ExecutionInspectionRecord,
	InspectionContextObservation,
	InspectionMessage,
} from "@leitwerk-dev/domain";
import type { InspectionConfigurationRevision } from "@leitwerk-dev/protocol";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import { executionInspections, inspectionContents } from "./schema.js";

/** Narrow capture projection sufficient for execution trace assembly without unpacking prompts or tools. @internal */
export type TraceInspectionCapture = Pick<
	ExecutionInspectionRecord,
	"id" | "workerLeaseId" | "timestamp"
> & {
	/** @internal */
	fact:
		| Extract<ExecutionInspectionCapture["fact"], { kind: "entry_link" }>
		| {
				/** @internal */
				kind: "model_input";
				/** @internal */
				messages: InspectionMessage[];
		  };
};

const DIGEST_BATCH_SIZE = 500;

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
	function collectDigests(value: unknown, digests: Set<string>): void {
		if (Array.isArray(value)) {
			for (const item of value) collectDigests(item, digests);
			return;
		}
		if (!value || typeof value !== "object") return;
		const record = value as Record<string, unknown>;
		if (typeof record.contentDigest === "string") {
			digests.add(record.contentDigest);
			return;
		}
		for (const item of Object.values(record)) collectDigests(item, digests);
	}
	function loadContents(digests: ReadonlySet<string>): Map<string, unknown> {
		const loaded = new Map<string, unknown>();
		if (digests.size === 0) return loaded;
		const all = [...digests];
		for (let i = 0; i < all.length; i += DIGEST_BATCH_SIZE) {
			const batch = all.slice(i, i + DIGEST_BATCH_SIZE);
			const rows = db
				.select()
				.from(inspectionContents)
				.where(inArray(inspectionContents.digest, batch))
				.all();
			for (const row of rows) {
				loaded.set(row.digest, JSON.parse(row.contentJson));
			}
		}
		return loaded;
	}
	function unpackWith(value: unknown, contents: ReadonlyMap<string, unknown>): unknown {
		if (Array.isArray(value)) return value.map((item) => unpackWith(item, contents));
		if (!value || typeof value !== "object") return value;
		const record = value as Record<string, unknown>;
		if (typeof record.contentDigest === "string") {
			return contents.has(record.contentDigest)
				? { state: record.state, value: contents.get(record.contentDigest) }
				: { state: "unavailable", reason: "Recorded content is unavailable" };
		}
		return Object.fromEntries(
			Object.entries(record).map(([key, item]) => [key, unpackWith(item, contents)]),
		);
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
			const rows = db
				.select()
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						eq(executionInspections.turnRecordId, turnRecordId),
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all();
			const parsed = rows.map((row) => ({
				row,
				fact: JSON.parse(row.factJson) as unknown,
			}));
			const digests = new Set<string>();
			for (const entry of parsed) collectDigests(entry.fact, digests);
			const contents = loadContents(digests);
			return parsed.map(({ row, fact }) => ({
				version: 1,
				id: row.id,
				sequence: row.sequence,
				instanceId: row.instanceId,
				turnRecordId: row.turnRecordId,
				startRecordId: row.startRecordId,
				workerLeaseId: row.workerLeaseId,
				timestamp: row.capturedAt,
				fact: unpackWith(fact, contents) as ExecutionInspectionCapture["fact"],
			}));
		},
		/** Trace evidence: entry links and user prompt fallbacks only, without unpacking prompts, tools, or non-user messages. @internal */
		listForTrace(instanceId: string, turnRecordId: string): TraceInspectionCapture[] {
			const rows = db
				.select()
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						eq(executionInspections.turnRecordId, turnRecordId),
						sql`json_extract(${executionInspections.factJson}, '$.kind') IN ('entry_link', 'model_input')`,
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all();
			const parsed: Array<{
				row: typeof executionInspections.$inferSelect;
				kind: "entry_link" | "model_input";
				fact: Record<string, unknown>;
			}> = [];
			const digests = new Set<string>();
			const seenUserEntries = new Set<string>();
			for (const row of rows) {
				const fact = JSON.parse(row.factJson) as Record<string, unknown>;
				if (fact.kind === "entry_link") {
					parsed.push({ row, kind: "entry_link", fact });
				} else if (fact.kind === "model_input" && Array.isArray(fact.messages)) {
					const userMessages = fact.messages.filter((message) => {
						if (!message || typeof message !== "object") return false;
						const record = message as Record<string, unknown>;
						if (record.role !== "user" || typeof record.entryId !== "string") return false;
						if (seenUserEntries.has(record.entryId)) return false;
						seenUserEntries.add(record.entryId);
						return true;
					});
					if (userMessages.length === 0) continue;
					collectDigests(userMessages, digests);
					parsed.push({
						row,
						kind: "model_input",
						fact: { kind: "model_input", messages: userMessages },
					});
				}
			}
			const contents = loadContents(digests);
			return parsed.map(({ row, kind, fact }) => ({
				id: row.id,
				workerLeaseId: row.workerLeaseId,
				timestamp: row.capturedAt,
				fact: (kind === "entry_link"
					? fact
					: {
							kind: "model_input",
							messages: unpackWith(fact.messages, contents) as InspectionMessage[],
						}) as TraceInspectionCapture["fact"],
			}));
		},
		/** Small origin/product references for compact lineage without loading prompts. @internal */
		listContextFacts(instanceId: string, turnRecordIds?: string[]): InspectionContextObservation[] {
			if (turnRecordIds?.length === 0) return [];
			return db
				.select()
				.from(executionInspections)
				.where(
					and(
						eq(executionInspections.instanceId, instanceId),
						turnRecordIds ? inArray(executionInspections.turnRecordId, turnRecordIds) : undefined,
						sql`json_extract(${executionInspections.factJson}, '$.kind') IN ('supplied_context', 'product_consumed', 'entry_link')`,
					),
				)
				.orderBy(asc(executionInspections.sequence))
				.all()
				.map((row) => {
					const fact = JSON.parse(row.factJson) as Extract<
						ExecutionInspectionCapture["fact"],
						{ kind: "supplied_context" | "product_consumed" | "entry_link" }
					>;
					return {
						id: row.id,
						turnRecordId: row.turnRecordId,
						fact:
							fact.kind === "supplied_context"
								? {
										...fact,
										products: fact.products.map(({ content: _content, ...source }) => source),
									}
								: fact,
					};
				});
		},
	};
}
