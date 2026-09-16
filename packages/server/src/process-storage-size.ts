import type { ProcessInstance, ProcessProject } from "@leitwerk-dev/domain";
import type { ExtensionProcessDefinition } from "@leitwerk-dev/process-sdk";
import { WorkerStartDiagnosticError } from "@leitwerk-dev/worker-runners/types";
import type { LeitwerkConfig } from "./config/config-types.js";

/** Positive Kubernetes resource quantity; whitespace and negative sizes are invalid. */
export function isValidStorageSize(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const match = /^(\+?(?:\d+(?:\.\d*)?|\.\d+))([numkMGTPE]|[KMGTPE]i|[eE][+-]?\d+)?$/.exec(value);
	if (!match || match[0] !== value) return false;
	const numeric = Number(
		/^[eE][+-]?\d+$/.test(match[2] ?? "") ? `${match[1]}${match[2]}` : match[1],
	);
	return Number.isFinite(numeric) && numeric > 0;
}

/** Capacity is consumed only by Kubernetes, never as a local/Docker disk quota. */
export function resolveProcessStorageSize(input: {
	config: LeitwerkConfig;
	process: Pick<ProcessInstance, "processId" | "paramsJson">;
	definition: ExtensionProcessDefinition | undefined;
	projects: readonly ProcessProject[];
}): string | undefined {
	const { config, process, definition, projects } = input;
	if (config.workers.runner !== "kubernetes") return undefined;
	let size = config.process_configs?.[process.processId]?.storage_size;
	let source = `process_configs.${process.processId}.storage_size`;
	if (size === undefined && definition?.resolveStorageSize) {
		const params = definition.paramsCodec.parse(
			process.paramsJson ? JSON.parse(process.paramsJson) : undefined,
		);
		size = definition.resolveStorageSize({ params, projects });
		source = `Process '${process.processId}' resolveStorageSize()`;
	}
	if (size === undefined) {
		size = config.kubernetes?.process_volume.size;
		source = "kubernetes.process_volume.size";
	}
	if (!isValidStorageSize(size)) {
		throw new WorkerStartDiagnosticError(
			`${source} must be a positive storage quantity (for example, 128Mi or 1Gi).`,
		);
	}
	return size;
}
