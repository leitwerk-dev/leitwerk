import {
	type FutureExecutionKind,
	PROCESS_SEMANTIC_ENTRY_REF_KEYS,
	PROCESS_TURN_RECORD_PATH_TYPES,
	PROCESS_TURN_TYPES,
	type ProcessInput,
	type ProcessInstance,
	type ProcessProject,
	type WorkerLease,
} from "@leitwerk-dev/domain";
import * as v from "valibot";
import type { StreamableWorkerEventType } from "./streamable-events.js";

export type ParseResult<T> = { ok: true; value: T } | { ok: false; error: string };

export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
export const err = (error: string): ParseResult<never> => ({ ok: false, error });
export const unknownRecordSchema = v.custom<Record<string, unknown>>(
	(value): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value),
	"must be an object",
);
export const nullableStringSchema = v.nullable(v.string());
export const optionalNullableStringSchema = v.optional(nullableStringSchema);

export function parseSchema<TSchema extends v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>>(
	schema: TSchema,
	value: unknown,
	context: string,
): ParseResult<v.InferOutput<TSchema>> {
	const parsed = v.safeParse(schema, value);
	if (parsed.success) {
		return ok(parsed.output);
	}
	const issue = parsed.issues?.[0];
	const target = issue ? [context, v.getDotPath(issue)].filter(Boolean).join(".") : context;
	return err(
		issue?.message === "must be an object"
			? `${target} must be an object`
			: `${target} ${issue?.message ?? "is invalid"}`,
	);
}

export function parseLiteral<T extends string>(
	value: unknown,
	allowed: readonly T[],
	context: string,
): ParseResult<T> {
	return v.is(v.picklist(allowed), value)
		? ok(value as T)
		: err(`${context} must be one of: ${allowed.join(", ")}`);
}

export const WS_PROTOCOL_VERSION = "leitwerk/ws/v1";

export const WS_PROCESS_TYPES = {
	TOAST: "process.toast",
	FUTURE_UPDATED: "future.updated",
} as const;

export const WS_PRIMARY_PATH_TYPES = {
	TURN_STARTED: "primary_path.turn_started",
	ASSISTANT_PARTIAL: "primary_path.assistant_partial",
	USAGE_UPDATED: "primary_path.usage_updated",
	ASSISTANT_COMMITTED: "primary_path.assistant_committed",
	TOOL_CALL_STARTED: "primary_path.tool_call_started",
	TOOL_CALL_COMPLETED: "primary_path.tool_call_completed",
	TURN_ANNOTATION_CHANGED: "primary_path.turn_annotation_changed",
	LABEL_CHANGED: "primary_path.label_changed",
	CHANGED: "primary_path.changed",
} as const;

export const WS_PI_STREAM_TYPES = {
	STARTED: "pi.stream.started",
	DELTA: "pi.stream.delta",
	COMPLETED: "pi.stream.completed",
	TOOL_STARTED: "pi.tool.started",
	TOOL_COMPLETED: "pi.tool.completed",
	LABEL_CHANGED: "pi.label.changed",
	ERROR: "pi.error",
	RETRY_START: "pi.retry.start",
	RETRY_END: "pi.retry.end",
	USAGE: "pi.usage",
} as const;

type PiPayload<T = Record<string, never>> = {
	turnId?: string | null;
	turnRecordId?: string | null;
	timestamp?: string;
} & T;

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const semanticEntryRefSchema = v.object({
	entryId: v.string(),
	turnRecordId: nullableStringSchema,
});
const primaryPathBasePayloadEntries = {
	turnRecordId: nullableStringSchema,
	piTurnId: nullableStringSchema,
	timestamp: v.string(),
};
const primaryPathTreeEntries = {
	rootEntry: v.nullable(semanticEntryRefSchema),
	currentLeaf: v.nullable(semanticEntryRefSchema),
};
const primaryPathTreeSchema = v.object(primaryPathTreeEntries);
const processTurnRecordSummarySchema = v.object({
	id: v.string(),
	turnId: v.string(),
	turnType: v.picklist(PROCESS_TURN_TYPES),
	pathType: v.picklist(PROCESS_TURN_RECORD_PATH_TYPES),
	startedAt: v.string(),
});
const usageCostSnapshotSchema = v.object({
	input: finiteNumberSchema,
	output: finiteNumberSchema,
	reasoning: v.optional(finiteNumberSchema),
	cacheRead: finiteNumberSchema,
	cacheWrite: finiteNumberSchema,
	total: finiteNumberSchema,
});
const usageSnapshotSchema = v.object({
	input: finiteNumberSchema,
	output: finiteNumberSchema,
	cacheRead: finiteNumberSchema,
	cacheWrite: finiteNumberSchema,
	totalTokens: finiteNumberSchema,
	cost: v.nullable(usageCostSnapshotSchema),
});
const turnAnnotationReferenceSchema = v.variant("kind", [
	v.object({
		kind: v.literal("turn_record"),
		turnRecordId: v.string(),
		role: nullableStringSchema,
	}),
	v.object({
		kind: v.literal("entry"),
		entryId: v.string(),
		role: nullableStringSchema,
	}),
	v.object({
		kind: v.literal("semantic_entry_ref"),
		ref: v.picklist(PROCESS_SEMANTIC_ENTRY_REF_KEYS),
		role: nullableStringSchema,
	}),
]);
const processTurnAnnotationSchema = v.object({
	id: v.string(),
	instanceId: v.string(),
	annotationType: v.string(),
	annotationKey: nullableStringSchema,
	references: v.array(turnAnnotationReferenceSchema),
	payload: unknownRecordSchema,
	createdAt: v.string(),
	updatedAt: v.string(),
});
const PRIMARY_PATH_PAYLOAD_SCHEMAS = {
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: v.object({
		turnRecord: processTurnRecordSummarySchema,
	}),
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: v.object({
		...primaryPathBasePayloadEntries,
		text: v.string(),
		streamType: v.string(),
	}),
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: v.object({
		...primaryPathBasePayloadEntries,
		usage: usageSnapshotSchema,
	}),
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: v.object({
		turnRecord: processTurnRecordSummarySchema,
		...primaryPathTreeEntries,
	}),
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: v.object({
		...primaryPathBasePayloadEntries,
		toolCallId: v.string(),
		toolName: v.string(),
		arguments: v.nullable(unknownRecordSchema),
	}),
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: v.object({
		...primaryPathBasePayloadEntries,
		toolCallId: v.string(),
		toolName: v.string(),
		result: v.unknown(),
		isError: v.boolean(),
	}),
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: v.object({
		change: v.picklist(["created", "updated"] as const),
		annotation: processTurnAnnotationSchema,
	}),
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: v.object({
		...primaryPathBasePayloadEntries,
		targetId: nullableStringSchema,
		label: nullableStringSchema,
	}),
	[WS_PRIMARY_PATH_TYPES.CHANGED]: primaryPathTreeSchema,
} as const satisfies Record<
	(typeof WS_PRIMARY_PATH_TYPES)[keyof typeof WS_PRIMARY_PATH_TYPES],
	v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>;
type PrimaryPathPayloadByType = {
	[K in keyof typeof PRIMARY_PATH_PAYLOAD_SCHEMAS]: v.InferOutput<
		(typeof PRIMARY_PATH_PAYLOAD_SCHEMAS)[K]
	>;
};
type PrimaryPathTree = v.InferOutput<typeof primaryPathTreeSchema>;
type PiUsagePayload = PiPayload<{
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens?: number;
	cost?: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		total?: number;
	};
	cacheHitRate?: number;
}>;

export type WsDurability = "durable" | "ephemeral";

export type ProcessAttentionTarget =
	| { kind: "action_required" }
	| { kind: "turn_failed" }
	| { kind: "worker_failed" }
	| { kind: "question_request"; requestId: string };

export type WsPayloadByType = {
	hello: { serverVersion: string };
	pong: Record<string, never>;
	"process.created": { process: ProcessInstance; processId: string; launcherId?: string };
	"process.updated": { process: Partial<ProcessInstance>; changedFields?: readonly string[] };
	"process.deleted": { instanceId: string };
	"project.updated": {
		projectId: string;
		project: {
			key: string;
			repoLocator: string;
			repoLocatorKind: ProcessProject["repoLocatorKind"];
			branch: string;
			baseBranch: string;
			workBranch: string | null;
			externalId: string | null;
			externalUrl: string | null;
			pipelineStatus: string | null;
		};
	};
	"worker.state": {
		worker: WorkerLease;
		workerId: string;
		state: WorkerLease["state"];
		previousState: WorkerLease["state"];
		reason: string;
	};
	"process.input.queued": { instanceId: string; input: ProcessInput };
	"process.input.acknowledged": { instanceId: string; inputId: string; sequence: number };
	"process.event": { eventType: string; level: string; message: string };
	[WS_PROCESS_TYPES.TOAST]: {
		instanceId: string;
		level: "warn" | "error";
		message: string;
		eventType: string;
		dedupeKey: string;
		ttlMs: number;
		/** Optional typed Chronicle target applied only when the operator opens the toast. */
		focusTarget?: ProcessAttentionTarget;
	};
	[WS_PROCESS_TYPES.FUTURE_UPDATED]: {
		futureExecutionId: string;
		operation: "created" | "updated" | "deleted";
		kind: FutureExecutionKind;
	};
	"plan.updated": { planRevision: number; reviewState: string; approved: boolean; summary: string };
	"review.updated": {
		hasIssues: boolean;
		issueCount: number;
		reviewMarkdown?: string;
		nextTurnId: string | null;
	};
	[WS_PI_STREAM_TYPES.STARTED]: PiPayload;
	[WS_PI_STREAM_TYPES.DELTA]: PiPayload<{
		text?: string;
		delta?: string;
		chunk?: string;
		streamType?: string;
	}>;
	[WS_PI_STREAM_TYPES.COMPLETED]: PiPayload;
	[WS_PI_STREAM_TYPES.TOOL_STARTED]: PiPayload<{
		toolCallId?: string;
		toolName?: string;
		name?: string;
		arguments?: Record<string, unknown>;
		args?: Record<string, unknown>;
	}>;
	[WS_PI_STREAM_TYPES.TOOL_COMPLETED]: PiPayload<{
		toolCallId?: string;
		toolName?: string;
		name?: string;
		result?: unknown;
		isError?: boolean;
	}>;
	[WS_PI_STREAM_TYPES.LABEL_CHANGED]: PiPayload<{
		targetId?: string | null;
		label?: string | null;
	}>;
	[WS_PI_STREAM_TYPES.ERROR]: PiPayload<{
		message?: string;
		errorMessage?: string;
		source?: string;
		toolName?: string;
		stopReason?: string;
		provider?: string;
		model?: string;
	}>;
	[WS_PI_STREAM_TYPES.RETRY_START]: PiPayload<{
		attempt?: number;
		maxAttempts?: number;
		delayMs?: number;
		errorMessage?: string;
		message?: string;
	}>;
	[WS_PI_STREAM_TYPES.RETRY_END]: PiPayload<{
		success?: boolean;
		attempt?: number;
		finalError?: string;
		message?: string;
	}>;
	[WS_PI_STREAM_TYPES.USAGE]: PiUsagePayload;
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TURN_STARTED];
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL];
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.USAGE_UPDATED];
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED];
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED];
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED];
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED];
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.LABEL_CHANGED];
	[WS_PRIMARY_PATH_TYPES.CHANGED]: PrimaryPathTree;
};

export const WS_FRAME_DURABILITY = {
	hello: "ephemeral",
	pong: "ephemeral",
	"process.created": "durable",
	"process.updated": "durable",
	"process.deleted": "durable",
	"project.updated": "durable",
	"worker.state": "durable",
	"process.input.queued": "durable",
	"process.input.acknowledged": "durable",
	"process.event": "durable",
	[WS_PROCESS_TYPES.TOAST]: "ephemeral",
	[WS_PROCESS_TYPES.FUTURE_UPDATED]: "durable",
	"plan.updated": "durable",
	"review.updated": "durable",
	[WS_PI_STREAM_TYPES.STARTED]: "ephemeral",
	[WS_PI_STREAM_TYPES.DELTA]: "ephemeral",
	[WS_PI_STREAM_TYPES.COMPLETED]: "ephemeral",
	[WS_PI_STREAM_TYPES.TOOL_STARTED]: "ephemeral",
	[WS_PI_STREAM_TYPES.TOOL_COMPLETED]: "ephemeral",
	[WS_PI_STREAM_TYPES.LABEL_CHANGED]: "ephemeral",
	[WS_PI_STREAM_TYPES.ERROR]: "ephemeral",
	[WS_PI_STREAM_TYPES.RETRY_START]: "ephemeral",
	[WS_PI_STREAM_TYPES.RETRY_END]: "ephemeral",
	[WS_PI_STREAM_TYPES.USAGE]: "ephemeral",
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: "durable",
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: "ephemeral",
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: "ephemeral",
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: "durable",
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: "ephemeral",
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: "ephemeral",
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: "durable",
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: "durable",
	[WS_PRIMARY_PATH_TYPES.CHANGED]: "durable",
} as const satisfies Record<keyof WsPayloadByType, WsDurability>;

export type WsDurabilityByType = typeof WS_FRAME_DURABILITY;
export type KnownWsFrameType = keyof WsPayloadByType;
export type KnownDurableWsFrameType = {
	[K in KnownWsFrameType]: WsDurabilityByType[K] extends "durable" ? K : never;
}[KnownWsFrameType];
export type KnownEphemeralWsFrameType = {
	[K in KnownWsFrameType]: WsDurabilityByType[K] extends "ephemeral" ? K : never;
}[KnownWsFrameType];
export type WsFrameOfType<T extends KnownWsFrameType> = {
	protocol: typeof WS_PROTOCOL_VERSION;
	type: T;
	durability: WsDurabilityByType[T];
	sentAt: string;
	instanceId?: string;
	payload: WsPayloadByType[T];
};
export type DurableWsFrameInput = {
	[K in KnownDurableWsFrameType]: { type: K; instanceId?: string; payload: WsPayloadByType[K] };
}[KnownDurableWsFrameType];
export type EphemeralWsFrameInput = {
	[K in KnownEphemeralWsFrameType]: { type: K; instanceId?: string; payload: WsPayloadByType[K] };
}[KnownEphemeralWsFrameType];
export type WsFrame = { [K in KnownWsFrameType]: WsFrameOfType<K> }[KnownWsFrameType];
export type PrimaryPathWsFrameType =
	(typeof WS_PRIMARY_PATH_TYPES)[keyof typeof WS_PRIMARY_PATH_TYPES];
export type PrimaryPathWsFrame = Extract<WsFrame, { type: PrimaryPathWsFrameType }>;

const KNOWN_WS_FRAME_TYPES = Object.keys(WS_FRAME_DURABILITY) as KnownWsFrameType[];
const PRIMARY_PATH_WS_FRAME_TYPES = Object.values(
	WS_PRIMARY_PATH_TYPES,
) as PrimaryPathWsFrameType[];
const WS_FRAME_SCHEMA = v.looseObject({
	protocol: v.literal(WS_PROTOCOL_VERSION),
	type: v.picklist(KNOWN_WS_FRAME_TYPES),
	durability: v.picklist(["durable", "ephemeral"] as const),
	sentAt: v.string(),
	instanceId: v.optional(v.string()),
	payload: unknownRecordSchema,
});

export function parsePrimaryPathWsFrameInput(value: unknown): ParseResult<PrimaryPathWsFrame> {
	const frame = parseWsFrame(value);
	if (!frame.ok) {
		return frame;
	}
	const type = parseLiteral(
		frame.value.type,
		PRIMARY_PATH_WS_FRAME_TYPES,
		"primary_path ws frame.type",
	);
	if (!type.ok) {
		return type;
	}
	const payload = parseSchema(
		PRIMARY_PATH_PAYLOAD_SCHEMAS[type.value],
		frame.value.payload,
		`primary_path ws frame.payload (${type.value})`,
	);
	return payload.ok
		? ok({ ...frame.value, type: type.value, payload: payload.value } as PrimaryPathWsFrame)
		: payload;
}

export function parseWsFrame(value: unknown): ParseResult<WsFrame> {
	const frame = parseSchema(WS_FRAME_SCHEMA, value, "ws frame");
	if (!frame.ok) {
		return frame;
	}
	return frame.value.durability !== WS_FRAME_DURABILITY[frame.value.type]
		? err(
				`ws frame.durability must be '${WS_FRAME_DURABILITY[frame.value.type]}' for type '${frame.value.type}'`,
			)
		: ok(frame.value as WsFrame);
}

export function createDurableWsFrame(input: DurableWsFrameInput & { sentAt?: string }): WsFrame {
	return {
		protocol: WS_PROTOCOL_VERSION,
		type: input.type,
		durability: "durable",
		sentAt: input.sentAt ?? new Date().toISOString(),
		...(input.instanceId ? { instanceId: input.instanceId } : {}),
		payload: input.payload,
	} as WsFrame;
}

export function createEphemeralWsFrame(input: {
	type: KnownEphemeralWsFrameType;
	instanceId?: string;
	payload: WsPayloadByType[KnownEphemeralWsFrameType];
	sentAt?: string;
}): WsFrame {
	return {
		protocol: WS_PROTOCOL_VERSION,
		type: input.type,
		durability: "ephemeral",
		sentAt: input.sentAt ?? new Date().toISOString(),
		...(input.instanceId ? { instanceId: input.instanceId } : {}),
		payload: input.payload,
	} as WsFrame;
}

const WORKER_TO_WS_TYPE: Record<StreamableWorkerEventType, string> = {
	"pi.stream.delta": WS_PI_STREAM_TYPES.DELTA,
	"pi.turn.start": WS_PI_STREAM_TYPES.STARTED,
	"pi.turn.end": WS_PI_STREAM_TYPES.COMPLETED,
	"pi.tool.call": WS_PI_STREAM_TYPES.TOOL_STARTED,
	"pi.tool.result": WS_PI_STREAM_TYPES.TOOL_COMPLETED,
	"pi.label.changed": WS_PI_STREAM_TYPES.LABEL_CHANGED,
	"pi.error": WS_PI_STREAM_TYPES.ERROR,
	"pi.retry.start": WS_PI_STREAM_TYPES.RETRY_START,
	"pi.retry.end": WS_PI_STREAM_TYPES.RETRY_END,
	"pi.usage": WS_PI_STREAM_TYPES.USAGE,
};

export type RawPiDiagnosticWsFrameType =
	(typeof WS_PI_STREAM_TYPES)[keyof typeof WS_PI_STREAM_TYPES];

export function mapWorkerEventToWsType(workerEventType: string): RawPiDiagnosticWsFrameType | null {
	return (
		((WORKER_TO_WS_TYPE as Partial<Record<string, string>>)[workerEventType] as
			| RawPiDiagnosticWsFrameType
			| undefined) ?? null
	);
}
