import type { ExternalWriteType } from "@leitwerk-dev/domain";

/** @public */
export interface WriteIdentity {
	/** @public */
	writeType: ExternalWriteType;
	/** @public */
	dedupKey: string;
}

/** @public */
export interface WriteOperation<T extends NonNullable<unknown> = NonNullable<unknown>> {
	/** @public */
	execute(): Promise<T>;
	/** @public */
	reconcile(
		phase: "before_execute" | "after_execute_error" | "already_recorded",
	): Promise<T | null>;
	/** @public */
	toMetadata(value: T): Record<string, unknown>;
}

/** Process-bound write coordination supplied by the server. @public */
export interface ExternalWrites {
	/** Return the recovered or newly created remote value. @public */
	ensure<T extends NonNullable<unknown>>(
		identity: WriteIdentity,
		operation: WriteOperation<T>,
	): Promise<T>;
	/** Record completion without remote reconciliation. @public */
	logOnly(identity: WriteIdentity, execute: () => Promise<Record<string, unknown>>): Promise<void>;
}
