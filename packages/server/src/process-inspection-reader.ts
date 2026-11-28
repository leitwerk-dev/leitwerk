import type {
	InspectionEvidence,
	InspectionModelInput,
	ProcessTurnRecord,
} from "@leitwerk-dev/domain";
import {
	buildUsageSnapshotsByTurnRecordId,
	createLiveTurnProjection,
	type ExecutionInspectionConfiguration,
	type ExecutionInspectionContext,
	type ExecutionInspectionSummary,
	type ExecutionInspectionTrace,
	type InspectionTargetState,
	type TurnTraceSnapshot,
} from "@leitwerk-dev/protocol";
import { createInspectionLineage } from "./process-inspection.js";
import { buildInspectionTraceMessages } from "./process-inspection-trace.js";
import type { ProcessUiSnapshotAssembler } from "./process-ui-snapshot-presenter.js";

/** One server-owned adapter for compact facts and on-demand inspection evidence. @internal */
export class ProcessInspectionReader {
	constructor(private readonly deps: ConstructorParameters<typeof ProcessUiSnapshotAssembler>[0]) {}
	private selected(instanceId: string, turnRecordId: string) {
		if (!this.deps.processes.getById(instanceId)) return null;
		const record = this.deps.turnRecords.getById(turnRecordId);
		return record?.instanceId === instanceId ? record : null;
	}
	private lineageSnapshot(instanceId: string) {
		return {
			records: this.deps.turnRecords.listByInstance(instanceId),
			leases: this.deps.leases.listByInstance(instanceId),
			observations: this.deps.executionInspections.listContextFacts(instanceId),
		};
	}
	/** No session or immutable-content reads are needed to open the shell. */
	summary(instanceId: string, turnRecordId: string): ExecutionInspectionSummary | null {
		const record = this.selected(instanceId, turnRecordId);
		if (!record) return null;
		const records = this.deps.turnRecords
			.listByInstance(instanceId)
			.sort((a, b) => a.startedAt.localeCompare(b.startedAt) || a.id.localeCompare(b.id));
		const index = records.findIndex((candidate) => candidate.id === turnRecordId);
		const start = record.turnStartRecordId
			? this.deps.turnStarts.getById(record.turnStartRecordId)
			: null;
		const inputs = this.deps.executionInspections.modelInputs(instanceId, turnRecordId);
		const accepted =
			start && "start" in start.state && start.state.start?.kind === "llm"
				? start.state.start.model
				: null;
		let model: InspectionEvidence<InspectionModelInput["model"]> =
			record.turnType === "llm"
				? { state: "not_recorded", reason: "The historical model was not recorded" }
				: {
						state: "not_applicable",
						reason: `This ${record.turnType} execution does not invoke a model`,
					};
		const effective = inputs.at(-1)?.model;
		if (effective) model = { state: "recorded", value: effective };
		else if (accepted)
			model = {
				state: "recorded",
				value: {
					provider: accepted.providerId,
					id: accepted.modelId,
					thinkingLevel: accepted.thinkingLevel,
				},
			};
		const { turnResultMarkdown: _output, ...execution } = record;
		return {
			instanceId,
			execution,
			origin: createInspectionLineage(this.lineageSnapshot(instanceId)).origin(record),
			startKind: start
				? { state: "recorded", value: start.startKind }
				: { state: "not_recorded", reason: "Execution start kind was not recorded" },
			model,
			modelInputCount: inputs.length,
			usage: this.deps.turnSummaries.get(turnRecordId)?.usage ?? null,
			previousTurnRecordId: records[index - 1]?.id ?? null,
			nextTurnRecordId: records[index + 1]?.id ?? null,
		};
	}
	private missingModelEvidence<T>(record: ProcessTurnRecord): InspectionEvidence<T> {
		return record.turnType === "llm"
			? {
					state: "not_recorded",
					reason:
						"No model input was recorded for this execution. Historical instructions cannot be reconstructed from current settings.",
				}
			: {
					state: "not_applicable",
					reason: `This ${record.turnType} execution does not invoke a model`,
				};
	}
	configuration(instanceId: string, turnRecordId: string): ExecutionInspectionConfiguration | null {
		const record = this.selected(instanceId, turnRecordId);
		if (!record) return null;
		const revisions = this.deps.executionInspections
			.list(instanceId, turnRecordId)
			.flatMap((capture) => {
				if (capture.fact.kind !== "model_input") return [];
				const { messages: _messages, kind: _kind, ...configuration } = capture.fact;
				return [{ id: capture.id, timestamp: capture.timestamp, ...configuration }];
			});
		return {
			instanceId,
			turnRecordId,
			revisions: revisions.length
				? { state: "recorded", value: revisions }
				: this.missingModelEvidence(record),
			currentWorkflowTurnId: record.turnId,
		};
	}
	async context(
		instanceId: string,
		turnRecordId: string,
	): Promise<ExecutionInspectionContext | null> {
		const record = this.selected(instanceId, turnRecordId);
		if (!record) return null;
		const lineageSnapshot = this.lineageSnapshot(instanceId);
		const captures = this.deps.executionInspections.list(instanceId, turnRecordId);
		const session = await this.deps.sessionReader.readSessionTree(instanceId);
		const lineage = createInspectionLineage({ ...lineageSnapshot, tree: session.piTree });
		const supplies = captures.filter((capture) => capture.fact.kind === "supplied_context");
		const products = supplies.flatMap((capture) =>
			capture.fact.kind === "supplied_context"
				? capture.fact.products.map((product) => ({
						...product,
						supplyId: capture.id,
						consumed: captures.some(
							(candidate) =>
								candidate.fact.kind === "product_consumed" &&
								`${turnRecordId}:${candidate.fact.supplyId}` === capture.id &&
								candidate.fact.name === product.name,
						),
					}))
				: [],
		);
		const modelInputs = captures.flatMap((capture) =>
			capture.fact.kind === "model_input"
				? [
						{
							id: capture.id,
							timestamp: capture.timestamp,
							boundaryEntryId: capture.fact.boundaryEntryId,
							model: capture.fact.model,
							messages: capture.fact.messages.map((message) => {
								const sourceTurnRecordId = message.entryId ? lineage.owner(message.entryId) : null;
								return {
									entryId: message.entryId,
									sourceTurnRecordId,
									role: message.role,
									content:
										sourceTurnRecordId && sourceTurnRecordId !== turnRecordId
											? null
											: message.content,
								};
							}),
						},
					]
				: [],
		);
		const boundaries = new Set(
			modelInputs
				.map((revision) => revision.boundaryEntryId)
				.filter((id): id is string => id !== null),
		);
		if (record.resultPiEntryId) boundaries.add(record.resultPiEntryId);
		const contextEntries = new Map(
			[...boundaries].flatMap((boundary) =>
				session.piTree.getBranch(boundary).map((entry) => [entry.id, entry] as const),
			),
		);
		const compactions = [...contextEntries.values()].flatMap((entry) =>
			entry.type === "compaction"
				? [{ entryId: entry.id, firstKeptEntryId: entry.firstKeptEntryId, summary: entry.summary }]
				: [],
		);
		const inputMessages = buildInspectionTraceMessages({
			tree: session.piTree,
			record,
			captures,
			events: [],
			owner: lineage.owner,
		}).filter((message) => message.role === "user" || message.role === "system");
		return {
			instanceId,
			turnRecordId,
			origin: lineage.origin(record),
			ancestry: lineage.ancestry(record),
			products: supplies.length
				? { state: "recorded", value: products }
				: { state: "not_recorded", reason: "Supplied product versions were not recorded" },
			modelInputs: modelInputs.length
				? { state: "recorded", value: modelInputs }
				: this.missingModelEvidence(record),
			compactions,
			inputMessages,
		};
	}
	async trace(
		instanceId: string,
		turnRecordId: string,
		target: { entryId?: string; itemId?: string; boundaryFor?: string } = {},
	): Promise<ExecutionInspectionTrace | null> {
		// Keep every durable fact at the same boundary as the reasoning history.
		// Session storage is asynchronous and can advance independently.
		const record = this.selected(instanceId, turnRecordId);
		if (!record) return null;
		const lineageSnapshot = this.lineageSnapshot(instanceId);
		const captures = this.deps.executionInspections.listForTrace(instanceId, turnRecordId);
		const annotations = this.deps.turnAnnotations
			.listByInstance(instanceId)
			.filter((annotation) =>
				annotation.references.some(
					(reference) =>
						reference.kind === "turn_record" && reference.turnRecordId === turnRecordId,
				),
			);
		const throughEventSequence = this.deps.events.latestSequence(instanceId);
		const live = record.status === "running";
		const liveSignature = live
			? (this.deps.turnSummaries.getSession(instanceId)?.signature ?? null)
			: null;
		let events = live
			? this.deps.events.listByTurnRecord(instanceId, turnRecordId)
			: this.deps.events.listByTurnRecordExcludingTypes(instanceId, turnRecordId, [
					"pi.stream.delta",
				]);
		if (!live && target.itemId?.startsWith("event:")) {
			const seq = Number(target.itemId.slice(6));
			if (Number.isSafeInteger(seq) && !events.some((event) => event.eventSequence === seq)) {
				const targeted = this.deps.events.getByInstanceSequence(instanceId, seq);
				if (targeted && targeted.data.turnRecordId === turnRecordId) {
					events = [...events, targeted].sort(
						(a, b) => (a.eventSequence ?? 0) - (b.eventSequence ?? 0),
					);
				}
			}
		}
		const summaryUsage = !live ? (this.deps.turnSummaries.get(turnRecordId)?.usage ?? null) : null;
		const session = await this.deps.sessionReader.readSessionTree(instanceId);
		const lineage = createInspectionLineage({ ...lineageSnapshot, tree: session.piTree });
		const messages = buildInspectionTraceMessages({
			tree: session.piTree,
			record,
			captures,
			events,
			owner: lineage.owner,
		});
		let reasoning: TurnTraceSnapshot;
		if (live) {
			reasoning = createLiveTurnProjection(events).snapshot();
		} else if (messages.length === 0) {
			// Fallback when a committed/failed turn has no session entries uploaded yet.
			events = this.deps.events
				.listByTurnRecord(instanceId, turnRecordId)
				.filter((event) => (event.eventSequence ?? 0) <= throughEventSequence);
			reasoning = createLiveTurnProjection(events).snapshot();
			reasoning.usage ??=
				summaryUsage ?? buildUsageSnapshotsByTurnRecordId(events)[record.id] ?? null;
		} else {
			// Committed turns with session messages render from `messages`; avoid duplicating
			// multi-megabyte reasoning/tool payloads inside `reasoning`.
			reasoning = {
				assistant: { text: "", thinking: "", lastUpdatedAt: null },
				toolCalls: [],
				traceItems: [],
				usage: summaryUsage ?? buildUsageSnapshotsByTurnRecordId(events)[record.id] ?? null,
				piInput: null,
			};
		}
		let targetState: InspectionTargetState | null = null;
		let inheritedBoundary: ExecutionInspectionTrace["inheritedBoundary"] = null;
		const unavailable = {
			state: "unavailable",
			reason: "The requested item is unavailable or does not belong to this execution",
		} as const;
		let itemId = target.entryId ? `entry:${target.entryId}` : target.itemId;
		if (itemId === "input")
			itemId =
				messages.find((message) => message.role === "user" || message.role === "system")?.id ??
				itemId;
		if (itemId === "reasoning")
			itemId =
				messages
					.flatMap((message) => message.blocks)
					.find((block) => block.content.type === "thinking")?.id ??
				events
					.filter(
						(event) =>
							event.eventType === "pi.stream.delta" && event.data.streamType === "thinking",
					)
					.map((event) => `event:${event.eventSequence}`)[0] ??
				itemId;
		if (itemId) {
			const message = messages.find(
				(message) =>
					message.id === itemId ||
					message.aliases.includes(itemId) ||
					message.blocks.some((block) => block.id === itemId),
			);
			const event = events.find((event) => `event:${event.eventSequence}` === itemId);
			targetState =
				message || event
					? { state: "available", itemId: message?.aliases.includes(itemId) ? message.id : itemId }
					: unavailable;
		}
		if (target.boundaryFor) {
			const child = lineageSnapshot.records.find((record) => record.id === target.boundaryFor);
			const context = child ? lineage.origin(child).conversation : null;
			const boundary = context?.state === "recorded" ? context.value : null;
			if (
				boundary?.turnRecordId === turnRecordId &&
				(!target.entryId || boundary.entryId === target.entryId)
			) {
				inheritedBoundary = boundary;
				targetState = messages.some((message) => message.entryId === boundary.entryId)
					? { state: "available", itemId: `entry:${boundary.entryId}` }
					: {
							state: "unavailable",
							reason: "The inheritance boundary is recorded, but its source entry is unavailable",
						};
			} else targetState = unavailable;
		}
		return {
			instanceId,
			turnRecordId,
			sessionSignature: live ? liveSignature : (session.signature ?? null),
			state: live ? "live" : "committed",
			throughEventSequence,
			reasoning,
			messages,
			unassignedMessages: buildInspectionTraceMessages({
				tree: session.piTree,
				record,
				scope: "unassigned_branch",
				captures: [],
				events: [],
				owner: lineage.owner,
			}),
			events,
			annotations,
			output: record.turnResultMarkdown,
			target: targetState,
			inheritedBoundary,
		};
	}
}
