import type { PostCommitEffect } from "../effects/post-commit-effect.js";
import type { RecordCommit } from "../process-engine/writes/commit-writes.js";
import {
	createWrites,
	type DecisionMetadata,
	type Writes,
} from "../process-engine/writes/writes.js";
import type { EngineErrorCode } from "./types.js";

export type Reaction = PostCommitEffect;

export interface Decision<TData = void> {
	ok: true;
	writes: Writes;
	data: TData;
	metadata?: DecisionMetadata;
	/**
	 * Used when operation data is only known after the durable commit. For example,
	 * queued inputs receive durable sequence numbers while recording.
	 */
	deriveData?: (commit: RecordCommit) => TData;
}

export interface RejectedDecision<TData = unknown> {
	ok: false;
	code: EngineErrorCode;
	message: string;
	data?: TData;
}

export type DecideResult<TData> = Decision<TData> | RejectedDecision<TData>;

export function accept<TData = void>(
	input: {
		writes?: Partial<Writes>;
		data?: TData;
		metadata?: DecisionMetadata;
		deriveData?: (commit: RecordCommit) => TData;
	} = {},
): Decision<TData> {
	return {
		ok: true,
		writes: createWrites(input.writes),
		data: input.data as TData,
		...(input.metadata ? { metadata: input.metadata } : {}),
		...(input.deriveData ? { deriveData: input.deriveData } : {}),
	};
}

export function reject<TData = unknown>(
	code: EngineErrorCode,
	message: string,
	options: { data?: TData } = {},
): RejectedDecision<TData> {
	return {
		ok: false,
		code,
		message,
		...(options.data !== undefined ? { data: options.data } : {}),
	};
}

export function noWrites<TData = void>(input: { data?: TData } = {}): Decision<TData> {
	return accept({ data: input.data });
}
