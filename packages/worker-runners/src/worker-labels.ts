/**
 * Shared labelling for worker units across runner modes.
 *
 * Labels are how the server reconciles which workers exist after a restart:
 * there is no pid registry, the container/pod runtime is the source of truth.
 * Both the Docker and Kubernetes runners stamp these labels at start and read
 * them back during the adoption scan, so the keys and parse rules live here
 * rather than in a runtime-specific body.
 */

export const WORKER_LABEL_MANAGED_BY = "leitwerk.dev/managed-by";
export const WORKER_LABEL_COMPONENT = "leitwerk.dev/component";
export const WORKER_LABEL_INSTANCE_ID = "leitwerk.dev/instance-id";
export const WORKER_LABEL_WORKER_ID = "leitwerk.dev/worker-id";
export const WORKER_LABEL_SERVER_EPOCH = "leitwerk.dev/server-epoch";

export const WORKER_LABEL_MANAGED_BY_VALUE = "leitwerk";
export const WORKER_LABEL_COMPONENT_VALUE = "worker";
export const PROCESS_NAMESPACE_COMPONENT_VALUE = "process-namespace";
export const PROCESS_VOLUME_COMPONENT_VALUE = "process-volume";
export const PROCESS_SERVER_CA_COMPONENT_VALUE = "server-ca";

export interface WorkerUnitIdentity {
	instanceId: string;
	workerId: string;
	serverEpoch: string;
}

/**
 * Builds the canonical label set for a worker unit. Extra labels are merged in
 * but can never override the managed identity keys.
 */
export function buildWorkerUnitLabels(
	identity: WorkerUnitIdentity,
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...extra,
		[WORKER_LABEL_MANAGED_BY]: WORKER_LABEL_MANAGED_BY_VALUE,
		[WORKER_LABEL_COMPONENT]: WORKER_LABEL_COMPONENT_VALUE,
		[WORKER_LABEL_INSTANCE_ID]: identity.instanceId,
		[WORKER_LABEL_WORKER_ID]: identity.workerId,
		[WORKER_LABEL_SERVER_EPOCH]: identity.serverEpoch,
	};
}

/**
 * Builds labels for durable process-scoped resources (namespace/PVC). These
 * intentionally omit worker-id and server-epoch because the resources outlive a
 * specific worker lease and are not adoption targets.
 */
export function buildProcessResourceLabels(
	args: {
		instanceId: string;
		component:
			| typeof PROCESS_NAMESPACE_COMPONENT_VALUE
			| typeof PROCESS_VOLUME_COMPONENT_VALUE
			| typeof PROCESS_SERVER_CA_COMPONENT_VALUE;
	},
	extra: Record<string, string> = {},
): Record<string, string> {
	return {
		...extra,
		[WORKER_LABEL_MANAGED_BY]: WORKER_LABEL_MANAGED_BY_VALUE,
		[WORKER_LABEL_COMPONENT]: args.component,
		[WORKER_LABEL_INSTANCE_ID]: args.instanceId,
	};
}

/** Selector for the two managed-by/component keys shared by every managed resource. */
function managedResourceLabelSelector(component: string): Record<string, string> {
	return {
		[WORKER_LABEL_MANAGED_BY]: WORKER_LABEL_MANAGED_BY_VALUE,
		[WORKER_LABEL_COMPONENT]: component,
	};
}

export function managedProcessNamespaceLabelSelector(): Record<string, string> {
	return managedResourceLabelSelector(PROCESS_NAMESPACE_COMPONENT_VALUE);
}

/** True when the labels identify an leitwerk-managed worker unit. */
export function isManagedWorkerUnitLabels(labels: Record<string, string>): boolean {
	return (
		labels[WORKER_LABEL_MANAGED_BY] === WORKER_LABEL_MANAGED_BY_VALUE &&
		labels[WORKER_LABEL_COMPONENT] === WORKER_LABEL_COMPONENT_VALUE
	);
}

/**
 * Recovers the worker identity from a unit's labels, or `null` when the labels
 * do not describe a complete leitwerk-managed worker.
 */
export function parseWorkerUnitIdentity(labels: Record<string, string>): WorkerUnitIdentity | null {
	if (!isManagedWorkerUnitLabels(labels)) {
		return null;
	}
	const instanceId = labels[WORKER_LABEL_INSTANCE_ID];
	const workerId = labels[WORKER_LABEL_WORKER_ID];
	const serverEpoch = labels[WORKER_LABEL_SERVER_EPOCH];
	if (!instanceId || !workerId || !serverEpoch) {
		return null;
	}
	return { instanceId, workerId, serverEpoch };
}

/** Label selector for listing managed worker units in a runtime query. */
export function managedWorkerLabelSelector(): Record<string, string> {
	return managedResourceLabelSelector(WORKER_LABEL_COMPONENT_VALUE);
}
