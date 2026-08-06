import {
	type Actor,
	assertValidProcessProductName,
	type InputKind,
	type InputSource,
	isProcessSemanticEntryRefKey,
	type ProcessInput,
	type ProcessInputTarget,
} from "@leitwerk-dev/domain";
import type { InputDelivery } from "@leitwerk-dev/worker-protocol";
import type { RepositoryBundle } from "./db/repositories.js";
import type { WorkerSupervisor } from "./supervisor/worker-supervisor.js";
export interface QueuedProcessInput {
	source: InputSource;
	kind: InputKind;
	target?: ProcessInputTarget | null;
	bodyMarkdown: string;
	/** Stable principal that queued this input. Defaults to SYSTEM_ACTOR at persist time. */
	actor?: Actor;
}

export interface ProcessInputDispatchDeps {
	supervisor?: WorkerSupervisor;
}

export function toInputDelivery(input: ProcessInput): InputDelivery {
	return {
		inputId: input.id,
		sequence: input.sequence,
		source: input.source,
		kind: input.kind,
		target: input.target,
		receivedAt: input.receivedAt,
		bodyMarkdown: input.bodyMarkdown,
	};
}

export function validateQueuedProcessInput(input: QueuedProcessInput): string | null {
	if (!input.target) {
		return null;
	}
	if (input.kind !== "instruction") {
		return `Queued input target requires kind 'instruction', received '${input.kind}'`;
	}
	const semanticRef = input.target.semanticRef;
	const productName = input.target.productName;
	const hasSemanticRef = typeof semanticRef === "string";
	const hasProductName = typeof productName === "string";
	if (hasSemanticRef && hasProductName) {
		return "Queued input target must reference only one of semantic ref or product name";
	}
	if (hasSemanticRef) {
		if (!isProcessSemanticEntryRefKey(semanticRef)) {
			return `Queued input target references unknown semantic ref '${semanticRef}'`;
		}
	} else if (hasProductName) {
		try {
			assertValidProcessProductName(productName);
		} catch (error) {
			return error instanceof Error ? error.message : String(error);
		}
	} else {
		return "Queued input target must reference a semantic ref or product name";
	}
	if (input.bodyMarkdown.trim() === "") {
		return "Queued input target requires a non-empty bodyMarkdown";
	}
	return null;
}

export async function dispatchProcessInputs(
	deps: ProcessInputDispatchDeps,
	instanceId: string,
	inputsToDispatch: ProcessInput[],
	options: { spawnIfMissing?: boolean } = {},
): Promise<void> {
	if (inputsToDispatch.length === 0 || !deps.supervisor) {
		return;
	}

	const worker = deps.supervisor.getWorker(instanceId);
	if (worker) {
		deps.supervisor.deliverInputs(
			instanceId,
			inputsToDispatch.map((input) => toInputDelivery(input)),
		);
		return;
	}

	if (options.spawnIfMissing === false) {
		return;
	}

	await deps.supervisor.spawnWorker(instanceId);
}

export function persistQueuedProcessInputs(
	inputs: RepositoryBundle["inputs"],
	instanceId: string,
	queued: QueuedProcessInput[],
): ProcessInput[] {
	if (queued.length === 0) {
		return [];
	}

	let nextSequence = inputs.getMaxSequence(instanceId) + 1;
	const created = queued.map((item) =>
		inputs.create({
			instanceId,
			sequence: nextSequence++,
			source: item.source,
			kind: item.kind,
			target: item.target ?? null,
			bodyMarkdown: item.bodyMarkdown,
			...(item.actor ? { actor: item.actor } : {}),
		}),
	);

	return created;
}

export function buildInputQueuedFrames(
	instanceId: string,
	persistedInputs: readonly ProcessInput[],
) {
	return persistedInputs.map((input) => ({
		type: "process.input.queued" as const,
		payload: { instanceId, input },
		instanceId,
	}));
}
