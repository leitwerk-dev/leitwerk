import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type { EventBus, PiCustomTool } from "@leitwerk-dev/process-sdk";
import type { DevelopmentToolEnvironment } from "../development-tool-environment.js";
import type { WorkerIpc } from "../ipc.js";
import type { PiTreeHandleFactory } from "../pi-adapter.js";
import type { PromptGuardScheduler, PromptGuardTimer } from "../prompt-guards.js";
import type { WorkerSessionSnapshotExchange } from "../session-snapshot-exchange.js";
import type { RunRootGitOps } from "../workspace/run-root.js";
import type { CredentialRefreshDescriptor } from "./bootstrap-session.js";

export type WorkerRuntimeTimer = PromptGuardTimer;

/** @internal */
export interface WorkerRuntimeScheduler extends PromptGuardScheduler {
	/** @internal */
	sleep(delayMs: number): Promise<void>;
	/** @internal */
	now(): Date;
}

/** @internal */
export const nodeWorkerRuntimeScheduler: WorkerRuntimeScheduler = {
	setTimeout(handler, delayMs) {
		return setTimeout(handler, delayMs);
	},
	clearTimeout(timer) {
		clearTimeout(timer);
	},
	sleep(delayMs) {
		return new Promise((resolve) => setTimeout(resolve, delayMs));
	},
	now() {
		return new Date();
	},
};

/** @internal */
export interface WorkerRuntimeConfig {
	/** @internal */
	instanceId: string;
	/** @internal */
	workerId: string;
	/** @internal */
	heartbeatIntervalMs?: number;
	/** @internal */
	turnMaxDurationMs?: number;
	/** @internal */
	turnInactivityTimeoutMs?: number;
	/** @internal */
	turnAbortGracePeriodMs?: number;
}

/** @internal */
export interface ResultImageToolFactory {
	/** @internal */
	create(input: {
		/** @internal */
		workspaceRoot?: string;
		/** @internal */
		instanceId: string;
		/** @internal */
		turnRecordId: string;
	}): PiCustomTool | null;
}

/** @internal */
export interface WorkerRuntimeAdapters {
	/** @internal */
	transport: WorkerIpc;
	/** @internal */
	sessionSnapshots: WorkerSessionSnapshotExchange;
	/** @internal */
	resultImageTools: ResultImageToolFactory;
	/** @internal */
	piFactory: PiTreeHandleFactory;
	/** @internal */
	gitOps: RunRootGitOps;
	/** @internal */
	developmentTools?: DevelopmentToolEnvironment;
	/** @internal */
	scheduler: WorkerRuntimeScheduler;
	/** @internal */
	exit(code: number): void;
	/** @internal */
	stderr?: NodeJS.WritableStream;
	/** @internal */
	extensionEvents?: EventBus;
	/** @internal */
	sampleCredentials?: (descriptor: CredentialRefreshDescriptor) => Promise<{
		/** @internal */
		values: Record<string, string>;
		/** @internal */
		fingerprint: string;
	}>;
	/** @internal */
	resolveWorkerProcess?: (
		processId: string,
		opts?: {
			/** @internal */
			paramsJson?: string | null;
			/** @internal */
			stateJson?: string | null;
		},
	) => Promise<ResolvedWorkerProcess | undefined> | ResolvedWorkerProcess | undefined;
}

/** @internal */
export interface WorkerRuntimeOptions {
	/** @internal */
	config: WorkerRuntimeConfig;
	/** @internal */
	adapters: WorkerRuntimeAdapters;
}
