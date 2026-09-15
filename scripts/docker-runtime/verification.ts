import type { V1PersistentVolume, V1PersistentVolumeClaim, V1Pod } from "@kubernetes/client-node";

export interface DockerWorkerContract {
	runtimeClass: string;
	storageClass: string;
	workerImage: string;
}

export interface DockerWorkerEvidence {
	observedAt: string;
	pod: string;
	podUid: string;
	namespace: string;
	node: string;
	pvc: string;
	pvcUid: string;
	pv: string;
	pvUid: string;
	workerImage: string;
	workerImageId: string;
	innerImageId: string;
	marker: string;
	driver: string;
	dockerRootDir: string;
	dockerVersion: string | null;
	replacesPodUid?: string;
	previousPodDeletedAt?: string;
}

function requireValue(value: string | undefined, name: string): string {
	if (!value?.trim()) throw new Error(`Missing ${name}`);
	return value;
}

/** Check the admitted Pod and bound storage without imposing a storage backend. */
export function verifyDockerPod(
	pod: V1Pod,
	pvc: V1PersistentVolumeClaim,
	pv: V1PersistentVolume,
	expected: DockerWorkerContract,
) {
	const spec = pod.spec;
	if (!spec || spec.runtimeClassName !== expected.runtimeClass || spec.hostUsers !== false)
		throw new Error("Worker must use the selected runtime class with hostUsers=false");
	if (
		spec.hostNetwork ||
		spec.hostPID ||
		spec.hostIPC ||
		spec.volumes?.some((volume) => volume.hostPath)
	)
		throw new Error("Worker must not use host namespaces or hostPath volumes");
	for (const container of [
		...spec.containers,
		...(spec.initContainers ?? []),
		...(spec.ephemeralContainers ?? []),
	]) {
		if (
			container.securityContext?.privileged ||
			container.securityContext?.capabilities?.add?.length
		)
			throw new Error("Worker Pod must not have privileged containers or added capabilities");
		if (
			container.volumeMounts?.some((mount) =>
				/docker\.sock|containerd\.sock|crio\.sock|buildkit/i.test(
					`${mount.mountPath}/${mount.subPath ?? ""}`,
				),
			)
		)
			throw new Error("Worker Pod must not mount runtime sockets");
	}
	if (
		pod.status?.phase !== "Running" ||
		!pod.status.conditions?.some(
			(condition) => condition.type === "Ready" && condition.status === "True",
		)
	)
		throw new Error("Worker Pod must be Running and Ready");
	const worker = spec.containers.find((container) => container.name === "worker");
	const status = pod.status.containerStatuses?.find((container) => container.name === "worker");
	if (!worker || worker.image !== expected.workerImage || !status?.ready)
		throw new Error("Ready worker image must match the candidate image");
	const claims = spec.volumes?.filter((volume) => volume.persistentVolumeClaim);
	if (
		claims?.length !== 1 ||
		claims[0].persistentVolumeClaim?.claimName !== pvc.metadata?.name ||
		pvc.metadata?.namespace !== pod.metadata?.namespace
	)
		throw new Error("Worker must use exactly one process PVC in its namespace");
	if (
		!worker.volumeMounts?.some(
			(mount) =>
				mount.name === claims[0].name &&
				mount.mountPath === "/state" &&
				!mount.readOnly &&
				!mount.subPath &&
				!mount.subPathExpr,
		)
	)
		throw new Error("Worker must mount the complete writable process PVC at /state");
	if (
		pvc.spec?.storageClassName !== expected.storageClass ||
		pvc.status?.phase !== "Bound" ||
		pvc.spec.volumeName !== pv.metadata?.name
	)
		throw new Error("Process PVC must be Bound through the selected storage class");
	if (
		pv.spec?.claimRef?.uid !== pvc.metadata?.uid ||
		pv.spec?.claimRef?.name !== pvc.metadata?.name ||
		pv.spec?.claimRef?.namespace !== pvc.metadata?.namespace
	)
		throw new Error("PV claim identity must match the process PVC");
	return {
		pod: requireValue(pod.metadata?.name, "Pod name"),
		podUid: requireValue(pod.metadata?.uid, "Pod UID"),
		namespace: requireValue(pod.metadata?.namespace, "Pod namespace"),
		node: requireValue(spec.nodeName, "Pod node"),
		pvc: requireValue(pvc.metadata?.name, "PVC name"),
		pvcUid: requireValue(pvc.metadata?.uid, "PVC UID"),
		pv: requireValue(pv.metadata?.name, "PV name"),
		pvUid: requireValue(pv.metadata?.uid, "PV UID"),
		workerImage: expected.workerImage,
		workerImageId: requireValue(status.imageID, "running worker image ID"),
	};
}

export function verifyDockerDaemon(
	info: { Driver?: string; DockerRootDir?: string; ServerVersion?: string },
	listeners: number[],
) {
	if (info.Driver !== "overlay2" || info.DockerRootDir !== "/state/tooling/docker")
		throw new Error("Docker must use overlay2 with data at /state/tooling/docker");
	if (
		!Array.isArray(listeners) ||
		listeners.some((port) => !Number.isInteger(port) || port < 0 || port > 65535)
	)
		throw new Error("Invalid Docker listener evidence");
	if (listeners.some((port) => port === 2375 || port === 2376))
		throw new Error("Worker must not expose Docker TCP ports 2375 or 2376");
	return {
		driver: info.Driver,
		dockerRootDir: info.DockerRootDir,
		dockerVersion: info.ServerVersion ?? null,
	};
}

export function verifyDockerRetention(
	before: DockerWorkerEvidence,
	after: DockerWorkerEvidence,
	deletedAt: string,
): void {
	if (before.podUid === after.podUid)
		throw new Error("Retention proof requires a different physical Pod UID");
	const [first, deleted, second] = [before.observedAt, deletedAt, after.observedAt].map(Date.parse);
	if (![first, deleted, second].every(Number.isFinite) || first > deleted || deleted > second)
		throw new Error("Record confirmed Pod deletion between the two observations");
	for (const key of [
		"namespace",
		"pvc",
		"pvcUid",
		"pv",
		"pvUid",
		"workerImage",
		"workerImageId",
		"innerImageId",
		"marker",
	] as const) {
		if (!before[key] || before[key] !== after[key])
			throw new Error(`Replacement did not retain ${key}`);
	}
}
