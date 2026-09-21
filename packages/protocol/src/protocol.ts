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

/** @internal */
export type ParseResult<T> =
	| {
			/** @internal */
			ok: true;
			/** @internal */
			value: T;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			error: string;
	  };

/** @internal */
export const ok = <T>(value: T): ParseResult<T> => ({ ok: true, value });
/** @internal */
export const err = (error: string): ParseResult<never> => ({ ok: false, error });
/** @internal */
export const unknownRecordSchema = v.custom<Record<string, unknown>>(
	(value): value is Record<string, unknown> =>
		typeof value === "object" && value !== null && !Array.isArray(value),
	"must be an object",
);
/** @internal */
export const nullableStringSchema = v.nullable(v.string());
/** @internal */
export const optionalNullableStringSchema = v.optional(nullableStringSchema);

/** @internal */
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
	return err(`${target} ${issue?.message ?? "is invalid"}`);
}

/** @internal */
export function parseLiteral<T extends string>(
	value: unknown,
	allowed: readonly T[],
	context: string,
): ParseResult<T> {
	return v.is(v.picklist(allowed), value)
		? ok(value as T)
		: err(`${context} must be one of: ${allowed.join(", ")}`);
}

/** @internal */
export const WS_PROTOCOL_VERSION = "leitwerk/ws/v1";

/** @internal */
export const WS_PROCESS_TYPES = {
	/** @internal */
	TOAST: "process.toast",
	/** @internal */
	FUTURE_UPDATED: "future.updated",
} as const;

/** @internal */
export const WS_PRIMARY_PATH_TYPES = {
	/** @internal */
	TURN_STARTED: "primary_path.turn_started",
	/** @internal */
	ASSISTANT_PARTIAL: "primary_path.assistant_partial",
	/** @internal */
	SUMMARY_UPDATED: "primary_path.summary_updated",
	/** @internal */
	USAGE_UPDATED: "primary_path.usage_updated",
	/** @internal */
	ASSISTANT_COMMITTED: "primary_path.assistant_committed",
	/** @internal */
	TOOL_CALL_STARTED: "primary_path.tool_call_started",
	/** @internal */
	TOOL_CALL_COMPLETED: "primary_path.tool_call_completed",
	/** @internal */
	TURN_ANNOTATION_CHANGED: "primary_path.turn_annotation_changed",
	/** @internal */
	LABEL_CHANGED: "primary_path.label_changed",
	/** @internal */
	CHANGED: "primary_path.changed",
} as const;

/** @internal */
export const WS_PI_STREAM_TYPES = {
	/** @internal */
	STARTED: "pi.stream.started",
	/** @internal */
	DELTA: "pi.stream.delta",
	/** @internal */
	COMPLETED: "pi.stream.completed",
	/** @internal */
	TOOL_STARTED: "pi.tool.started",
	/** @internal */
	TOOL_COMPLETED: "pi.tool.completed",
	/** @internal */
	LABEL_CHANGED: "pi.label.changed",
	/** @internal */
	ERROR: "pi.error",
	/** @internal */
	RETRY_START: "pi.retry.start",
	/** @internal */
	RETRY_END: "pi.retry.end",
	/** @internal */
	USAGE: "pi.usage",
	/** @internal */
	COMPACTION_START: "pi.compaction.start",
	/** @internal */
	COMPACTION_END: "pi.compaction.end",
} as const;

/** @internal */
type PiPayload<T = Record<string, never>> = {
	/** @internal */
	turnId?: string | null;
	/** @internal */
	turnRecordId?: string | null;
	/** @internal */
	timestamp?: string;
} & T;

const finiteNumberSchema = v.pipe(v.number(), v.finite());
const semanticEntryRefSchema = v.object({
	/** @internal */
	entryId: v.string(),
	/** @internal */
	turnRecordId: nullableStringSchema,
});
const primaryPathBasePayloadEntries = {
	/** @internal */
	turnRecordId: nullableStringSchema,
	/** @internal */
	piTurnId: nullableStringSchema,
	/** @internal */
	timestamp: v.string(),
};
const primaryPathTreeEntries = {
	/** @internal */
	rootEntry: v.nullable(semanticEntryRefSchema),
	/** @internal */
	currentLeaf: v.nullable(semanticEntryRefSchema),
};
/** @internal */
const primaryPathTreeSchema = v.object(primaryPathTreeEntries);
const processTurnRecordSummarySchema = v.object({
	/** @internal */
	id: v.string(),
	/** @internal */
	turnId: v.string(),
	/** @internal */
	turnType: v.picklist(PROCESS_TURN_TYPES),
	/** @internal */
	pathType: v.picklist(PROCESS_TURN_RECORD_PATH_TYPES),
	/** @internal */
	startedAt: v.string(),
});
const usageCostSnapshotSchema = v.object({
	/** @internal */
	input: finiteNumberSchema,
	/** @internal */
	output: finiteNumberSchema,
	/** @internal */
	reasoning: v.optional(finiteNumberSchema),
	/** @internal */
	cacheRead: finiteNumberSchema,
	/** @internal */
	cacheWrite: finiteNumberSchema,
	/** @internal */
	total: finiteNumberSchema,
});
const usageSnapshotSchema = v.object({
	/** @internal */
	input: finiteNumberSchema,
	/** @internal */
	output: finiteNumberSchema,
	/** @internal */
	cacheRead: finiteNumberSchema,
	/** @internal */
	cacheWrite: finiteNumberSchema,
	/** @internal */
	totalTokens: finiteNumberSchema,
	/** @internal */
	cost: v.nullable(usageCostSnapshotSchema),
});
const turnAnnotationReferenceSchema = v.variant("kind", [
	v.object({
		/** @internal */
		kind: v.literal("turn_record"),
		/** @internal */
		turnRecordId: v.string(),
		/** @internal */
		role: nullableStringSchema,
	}),
	v.object({
		/** @internal */
		kind: v.literal("entry"),
		/** @internal */
		entryId: v.string(),
		/** @internal */
		role: nullableStringSchema,
	}),
	v.object({
		/** @internal */
		kind: v.literal("semantic_entry_ref"),
		/** @internal */
		ref: v.picklist(PROCESS_SEMANTIC_ENTRY_REF_KEYS),
		/** @internal */
		role: nullableStringSchema,
	}),
]);
const processTurnAnnotationSchema = v.object({
	/** @internal */
	id: v.string(),
	/** @internal */
	instanceId: v.string(),
	/** @internal */
	annotationType: v.string(),
	/** @internal */
	annotationKey: nullableStringSchema,
	/** @internal */
	references: v.array(turnAnnotationReferenceSchema),
	/** @internal */
	payload: unknownRecordSchema,
	/** @internal */
	createdAt: v.string(),
	/** @internal */
	updatedAt: v.string(),
});
/** @internal */
const PRIMARY_PATH_PAYLOAD_SCHEMAS = {
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED]: v.object({
		/** @internal */
		turnRecordId: v.string(),
		/** @internal */
		summary: v.object({
			/** @internal */
			assistant: v.object({
				/** @internal */
				text: v.pipe(v.string(), v.maxLength(1024)),
				/** @internal */
				thinking: v.pipe(v.string(), v.maxLength(1024)),
				/** @internal */
				lastUpdatedAt: nullableStringSchema,
			}),
			/** @internal */
			currentTool: v.nullable(
				v.object({
					/** @internal */
					toolCallId: v.pipe(v.string(), v.maxLength(256)),
					/** @internal */
					toolName: v.pipe(v.string(), v.maxLength(256)),
					/** @internal */
					status: v.picklist(["running", "completed"]),
					/** @internal */
					isError: v.boolean(),
				}),
			),
			/** @internal */
			usage: v.nullable(usageSnapshotSchema),
			/** @internal */
			toolCallCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
			/** @internal */
			traceItemCount: v.pipe(v.number(), v.integer(), v.minValue(0)),
			/** @internal */
			throughEventSequence: v.pipe(v.number(), v.integer(), v.minValue(0)),
			/** @internal */
			lastTraceKind: v.nullable(v.picklist(["thinking", "tool_call", "operational_event"])),
		}),
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: v.object({
		/** @internal */
		turnRecord: processTurnRecordSummarySchema,
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: v.object({
		...primaryPathBasePayloadEntries,
		/** @internal */
		text: v.string(),
		/** @internal */
		streamType: v.string(),
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: v.object({
		...primaryPathBasePayloadEntries,
		/** @internal */
		usage: usageSnapshotSchema,
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: v.object({
		/** @internal */
		turnRecord: processTurnRecordSummarySchema,
		...primaryPathTreeEntries,
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: v.object({
		...primaryPathBasePayloadEntries,
		/** @internal */
		toolCallId: v.string(),
		/** @internal */
		toolName: v.string(),
		/** @internal */
		arguments: v.nullable(unknownRecordSchema),
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: v.object({
		...primaryPathBasePayloadEntries,
		/** @internal */
		toolCallId: v.string(),
		/** @internal */
		toolName: v.string(),
		/** @internal */
		result: v.unknown(),
		/** @internal */
		isError: v.boolean(),
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: v.object({
		/** @internal */
		change: v.picklist(["created", "updated"] as const),
		/** @internal */
		annotation: processTurnAnnotationSchema,
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: v.object({
		...primaryPathBasePayloadEntries,
		/** @internal */
		targetId: nullableStringSchema,
		/** @internal */
		label: nullableStringSchema,
	}),
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.CHANGED]: primaryPathTreeSchema,
} as const satisfies Record<
	(typeof WS_PRIMARY_PATH_TYPES)[keyof typeof WS_PRIMARY_PATH_TYPES],
	v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>
>;
/** @internal */
type PrimaryPathPayloadByType = {
	[K in keyof typeof PRIMARY_PATH_PAYLOAD_SCHEMAS]: v.InferOutput<
		(typeof PRIMARY_PATH_PAYLOAD_SCHEMAS)[K]
	>;
};
/** @internal */
type PrimaryPathTree = v.InferOutput<typeof primaryPathTreeSchema>;
/** @internal */
type PiUsagePayload = PiPayload<{
	/** @internal */
	input?: number;
	/** @internal */
	output?: number;
	/** @internal */
	cacheRead?: number;
	/** @internal */
	cacheWrite?: number;
	/** @internal */
	totalTokens?: number;
	/** @internal */
	cost?: {
		/** @internal */
		input?: number;
		/** @internal */
		output?: number;
		/** @internal */
		cacheRead?: number;
		/** @internal */
		cacheWrite?: number;
		/** @internal */
		total?: number;
	};
	/** @internal */
	cacheHitRate?: number;
}>;

/** @internal */
export type WsDurability = "durable" | "ephemeral";

/** @internal */
export type ProcessAttentionTarget =
	| {
			/** @internal */
			kind: "action_required";
	  }
	| {
			/** @internal */
			kind: "turn_failed";
	  }
	| {
			/** @internal */
			kind: "worker_failed";
	  }
	| {
			/** @internal */
			kind: "question_request";
			/** @internal */
			requestId: string;
	  };

/** @internal */
export type WsPayloadByType = {
	/** @internal */
	hello: {
		/** @internal */
		serverVersion: string;
	};
	/** @internal */
	pong: Record<string, never>;
	/** @internal */
	"process.created": {
		/** @internal */
		process: ProcessInstance;
		/** @internal */
		processId: string;
		/** @internal */
		launcherId?: string;
	};
	/** @internal */
	"launch.updated": {
		/** @internal */
		launchRunId: string;
		/** @internal */
		instanceId: string | null;
	};
	/** @internal */
	"process.updated": {
		/** @internal */
		process: Partial<ProcessInstance>;
		/** @internal */
		changedFields?: readonly string[];
	};
	/** @internal */
	"process.deleted": {
		/** @internal */
		instanceId: string;
	};
	/** @internal */
	"session_transfer.updated": {
		/** @internal */
		attemptId: string;
	};
	/** @internal */
	"project.updated": {
		/** @internal */
		projectId: string;
		/** @internal */
		project: {
			/** @internal */
			key: string;
			/** @internal */
			repoLocator: string;
			/** @internal */
			repoLocatorKind: ProcessProject["repoLocatorKind"];
			/** @internal */
			branch: string;
			/** @internal */
			baseBranch: string;
			/** @internal */
			workBranch: string | null;
			/** @internal */
			externalId: string | null;
			/** @internal */
			externalUrl: string | null;
			/** @internal */
			pipelineStatus: string | null;
		};
	};
	/** @internal */
	"worker.state": {
		/** @internal */
		worker: WorkerLease;
		/** @internal */
		workerId: string;
		/** @internal */
		state: WorkerLease["state"];
		/** @internal */
		previousState: WorkerLease["state"];
		/** @internal */
		reason: string;
	};
	/** @internal */
	"process.input.queued": {
		/** @internal */
		instanceId: string;
		/** @internal */
		input: ProcessInput;
	};
	/** @internal */
	"process.input.acknowledged": {
		/** @internal */
		instanceId: string;
		/** @internal */
		inputId: string;
		/** @internal */
		sequence: number;
	};
	/** @internal */
	"process.event": {
		/** @internal */
		eventType: string;
		/** @internal */
		level: string;
		/** @internal */
		message: string;
	};
	/** @internal */
	[WS_PROCESS_TYPES.TOAST]: {
		/** @internal */
		instanceId: string;
		/** @internal */
		level: "warn" | "error";
		/** @internal */
		message: string;
		/** @internal */
		eventType: string;
		/** @internal */
		dedupeKey: string;
		/** @internal */
		ttlMs: number;
		/** Optional typed Chronicle target applied only when the operator opens the toast. @internal */
		focusTarget?: ProcessAttentionTarget;
	};
	/** @internal */
	[WS_PROCESS_TYPES.FUTURE_UPDATED]: {
		/** @internal */
		futureExecutionId: string;
		/** @internal */
		operation: "created" | "updated" | "deleted";
		/** @internal */
		kind: FutureExecutionKind;
	};
	/** @internal */
	"plan.updated": {
		/** @internal */
		planRevision: number;
		/** @internal */
		reviewState: string;
		/** @internal */
		approved: boolean;
		/** @internal */
		summary: string;
	};
	/** @internal */
	"review.updated": {
		/** @internal */
		hasIssues: boolean;
		/** @internal */
		issueCount: number;
		/** @internal */
		reviewMarkdown?: string;
		/** @internal */
		nextTurnId: string | null;
	};
	/** @internal */
	[WS_PI_STREAM_TYPES.STARTED]: PiPayload;
	/** @internal */
	[WS_PI_STREAM_TYPES.DELTA]: PiPayload<{
		/** @internal */
		text?: string;
		/** @internal */
		delta?: string;
		/** @internal */
		chunk?: string;
		/** @internal */
		streamType?: string;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPLETED]: PiPayload;
	/** @internal */
	[WS_PI_STREAM_TYPES.TOOL_STARTED]: PiPayload<{
		/** @internal */
		toolCallId?: string;
		/** @internal */
		toolName?: string;
		/** @internal */
		name?: string;
		/** @internal */
		arguments?: Record<string, unknown>;
		/** @internal */
		args?: Record<string, unknown>;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.TOOL_COMPLETED]: PiPayload<{
		/** @internal */
		toolCallId?: string;
		/** @internal */
		toolName?: string;
		/** @internal */
		name?: string;
		/** @internal */
		result?: unknown;
		/** @internal */
		isError?: boolean;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.LABEL_CHANGED]: PiPayload<{
		/** @internal */
		targetId?: string | null;
		/** @internal */
		label?: string | null;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.ERROR]: PiPayload<{
		/** @internal */
		message?: string;
		/** @internal */
		errorMessage?: string;
		/** @internal */
		source?: string;
		/** @internal */
		toolName?: string;
		/** @internal */
		stopReason?: string;
		/** @internal */
		provider?: string;
		/** @internal */
		model?: string;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.RETRY_START]: PiPayload<{
		/** @internal */
		attempt?: number;
		/** @internal */
		maxAttempts?: number;
		/** @internal */
		delayMs?: number;
		/** @internal */
		errorMessage?: string;
		/** @internal */
		message?: string;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.RETRY_END]: PiPayload<{
		/** @internal */
		success?: boolean;
		/** @internal */
		attempt?: number;
		/** @internal */
		finalError?: string;
		/** @internal */
		message?: string;
	}>;
	/** @internal */
	[WS_PI_STREAM_TYPES.USAGE]: PiUsagePayload;
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPACTION_START]: PiPayload<Record<string, unknown>>;
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPACTION_END]: PiPayload<Record<string, unknown>>;
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TURN_STARTED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.USAGE_UPDATED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: PrimaryPathPayloadByType[typeof WS_PRIMARY_PATH_TYPES.LABEL_CHANGED];
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.CHANGED]: PrimaryPathTree;
};

/** @internal */
export const WS_FRAME_DURABILITY = {
	/** @internal */
	hello: "ephemeral",
	/** @internal */
	pong: "ephemeral",
	/** @internal */
	"process.created": "durable",
	/** @internal */
	"launch.updated": "durable",
	/** @internal */
	"process.updated": "durable",
	/** @internal */
	"process.deleted": "durable",
	/** @internal */
	"session_transfer.updated": "durable",
	/** @internal */
	"project.updated": "durable",
	/** @internal */
	"worker.state": "durable",
	/** @internal */
	"process.input.queued": "durable",
	/** @internal */
	"process.input.acknowledged": "durable",
	/** @internal */
	"process.event": "durable",
	/** @internal */
	[WS_PROCESS_TYPES.TOAST]: "ephemeral",
	/** @internal */
	[WS_PROCESS_TYPES.FUTURE_UPDATED]: "durable",
	/** @internal */
	"plan.updated": "durable",
	/** @internal */
	"review.updated": "durable",
	/** @internal */
	[WS_PI_STREAM_TYPES.STARTED]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.DELTA]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPLETED]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.TOOL_STARTED]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.TOOL_COMPLETED]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.LABEL_CHANGED]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.ERROR]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.RETRY_START]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.RETRY_END]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.USAGE]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPACTION_START]: "ephemeral",
	/** @internal */
	[WS_PI_STREAM_TYPES.COMPACTION_END]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_STARTED]: "durable",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_PARTIAL]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.SUMMARY_UPDATED]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.USAGE_UPDATED]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.ASSISTANT_COMMITTED]: "durable",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_STARTED]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TOOL_CALL_COMPLETED]: "ephemeral",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.TURN_ANNOTATION_CHANGED]: "durable",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.LABEL_CHANGED]: "durable",
	/** @internal */
	[WS_PRIMARY_PATH_TYPES.CHANGED]: "durable",
} as const satisfies Record<keyof WsPayloadByType, WsDurability>;

/** @internal */
export type WsDurabilityByType = typeof WS_FRAME_DURABILITY;
/** @internal */
export type KnownWsFrameType = keyof WsPayloadByType;
/** @internal */
export type KnownDurableWsFrameType = {
	[K in KnownWsFrameType]: WsDurabilityByType[K] extends "durable" ? K : never;
}[KnownWsFrameType];
/** @internal */
export type KnownEphemeralWsFrameType = {
	[K in KnownWsFrameType]: WsDurabilityByType[K] extends "ephemeral" ? K : never;
}[KnownWsFrameType];
/** @internal */
export type WsFrameOfType<T extends KnownWsFrameType> = {
	/** @internal */
	protocol: typeof WS_PROTOCOL_VERSION;
	/** @internal */
	type: T;
	/** @internal */
	durability: WsDurabilityByType[T];
	/** @internal */
	sentAt: string;
	/** @internal */
	eventSequence?: number;
	/** @internal */
	instanceId?: string;
	/** @internal */
	payload: WsPayloadByType[T];
};
/** @internal */
type WsFrameInput<T extends KnownWsFrameType> = {
	[K in T]: Pick<WsFrameOfType<K>, "type" | "instanceId" | "eventSequence" | "payload">;
}[T];
/** @internal */
export type DurableWsFrameInput = WsFrameInput<KnownDurableWsFrameType>;
/** @internal */
export type EphemeralWsFrameInput = WsFrameInput<KnownEphemeralWsFrameType>;
/** @internal */
export type WsFrame = { [K in KnownWsFrameType]: WsFrameOfType<K> }[KnownWsFrameType];
/** @internal */
export type PrimaryPathWsFrameType =
	(typeof WS_PRIMARY_PATH_TYPES)[keyof typeof WS_PRIMARY_PATH_TYPES];
/** @internal */
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
	eventSequence: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
	instanceId: v.optional(v.string()),
	payload: unknownRecordSchema,
});

/** @internal */
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

/** @internal */
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

/** @internal */
export function createDurableWsFrame(
	input: DurableWsFrameInput & {
		/** @internal */
		sentAt?: string;
		/** @internal */
		eventSequence?: number;
	},
): WsFrame {
	return {
		protocol: WS_PROTOCOL_VERSION,
		type: input.type,
		durability: "durable",
		sentAt: input.sentAt ?? new Date().toISOString(),
		...(input.eventSequence !== undefined ? { eventSequence: input.eventSequence } : {}),
		...(input.instanceId ? { instanceId: input.instanceId } : {}),
		payload: input.payload,
	} as WsFrame;
}

/** @internal */
export function createEphemeralWsFrame(input: {
	/** @internal */
	type: KnownEphemeralWsFrameType;
	/** @internal */
	instanceId?: string;
	/** @internal */
	payload: WsPayloadByType[KnownEphemeralWsFrameType];
	/** @internal */
	sentAt?: string;
	/** @internal */
	eventSequence?: number;
}): WsFrame {
	return {
		protocol: WS_PROTOCOL_VERSION,
		type: input.type,
		durability: "ephemeral",
		sentAt: input.sentAt ?? new Date().toISOString(),
		...(input.eventSequence !== undefined ? { eventSequence: input.eventSequence } : {}),
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
	"pi.compaction.start": WS_PI_STREAM_TYPES.COMPACTION_START,
	"pi.compaction.end": WS_PI_STREAM_TYPES.COMPACTION_END,
};

/** @internal */
export type RawPiDiagnosticWsFrameType =
	(typeof WS_PI_STREAM_TYPES)[keyof typeof WS_PI_STREAM_TYPES];

/** @internal */
export function mapWorkerEventToWsType(workerEventType: string): RawPiDiagnosticWsFrameType | null {
	return (
		((WORKER_TO_WS_TYPE as Partial<Record<string, string>>)[workerEventType] as
			| RawPiDiagnosticWsFrameType
			| undefined) ?? null
	);
}
