import type { ProcessInstance, WorkerLease } from "@leitwerk-dev/domain";
import type { WorkerUnitDescriptor } from "@leitwerk-dev/worker-runners/types";

export type AdoptionClassification = "adopt" | "stop_stale" | "ignore_foreign";

export interface ClassifyWorkerDescriptorInput {
	descriptor: WorkerUnitDescriptor;
	process: Pick<ProcessInstance, "id"> | null;
	lease: Pick<
		WorkerLease,
		"workerId" | "state" | "connectTokenHash" | "modelPolicyFingerprint"
	> | null;
	expectedModelPolicyFingerprint: string;
	alreadyAttached: boolean;
	attachedDescriptorKey?: string | null;
}

export function workerDescriptorKey(descriptor: WorkerUnitDescriptor): string {
	return `${descriptor.namespace ?? ""}/${descriptor.unitId}`;
}

export function classifyWorkerDescriptor(
	input: ClassifyWorkerDescriptorInput,
): AdoptionClassification {
	if (
		input.descriptor.observedState === "terminal" ||
		!input.process ||
		!input.lease ||
		input.lease.workerId !== input.descriptor.workerId ||
		input.lease.state === "failed" ||
		input.lease.state === "exited" ||
		!input.lease.connectTokenHash ||
		!input.lease.modelPolicyFingerprint ||
		input.lease.modelPolicyFingerprint !== input.expectedModelPolicyFingerprint
	) {
		return "stop_stale";
	}
	if (input.alreadyAttached) {
		if (
			input.attachedDescriptorKey &&
			input.attachedDescriptorKey !== workerDescriptorKey(input.descriptor)
		) {
			return "stop_stale";
		}
		return "ignore_foreign";
	}
	return "adopt";
}
