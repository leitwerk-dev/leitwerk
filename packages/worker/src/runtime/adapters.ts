import type { ResolvedWorkerProcess } from "@leitwerk-dev/extension-runtime";
import type { EventBus, PiCustomTool } from "@leitwerk-dev/process-sdk";
import type { WorkerIpc } from "../ipc.js";
import type { PiTreeHandleFactory } from "../pi-adapter.js";
import type { PromptGuardScheduler, PromptGuardTimer } from "../prompt-guards.js";
import type { WorkerSessionSnapshotExchange } from "../session-snapshot-exchange.js";
import type { RunRootGitOps } from "../workspace/run-root.js";

export type WorkerRuntimeTimer = PromptGuardTimer;

export interface WorkerRuntimeScheduler extends PromptGuardScheduler {
	sleep(delayMs: number): Promise<void>;
	now(): Date;
}

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

export interface WorkerRuntimeConfig {
	instanceId: string;
	workerId: string;
	heartbeatIntervalMs?: number;
	turnMaxDurationMs?: number;
	turnInactivityTimeoutMs?: number;
	turnAbortGracePeriodMs?: number;
}

export interface ResultImageToolFactory {
	create(input: {
		workspaceRoot?: string;
		instanceId: string;
		turnRecordId: string;
	}): PiCustomTool | null;
}

export interface WorkerRuntimeAdapters {
	transport: WorkerIpc;
	sessionSnapshots: WorkerSessionSnapshotExchange;
	resultImageTools: ResultImageToolFactory;
	piFactory: PiTreeHandleFactory;
	gitOps: RunRootGitOps;
	scheduler: WorkerRuntimeScheduler;
	exit(code: number): void;
	stderr?: NodeJS.WritableStream;
	extensionEvents?: EventBus;
	resolveWorkerProcess?: (
		processId: string,
		opts?: { paramsJson?: string | null; stateJson?: string | null },
	) => Promise<ResolvedWorkerProcess | undefined> | ResolvedWorkerProcess | undefined;
}

export interface WorkerRuntimeOptions {
	config: WorkerRuntimeConfig;
	adapters: WorkerRuntimeAdapters;
}
