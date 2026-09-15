import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { V1PersistentVolume, V1PersistentVolumeClaim, V1Pod } from "@kubernetes/client-node";
import {
	type DockerWorkerEvidence,
	verifyDockerDaemon,
	verifyDockerPod,
	verifyDockerRetention,
} from "./verification.ts";

try {
	const [directory, previousFile, deletionFile] = process.argv.slice(2);
	if (!directory)
		throw new Error(
			"Usage: verify-kubernetes.ts SNAPSHOT_DIRECTORY [PREVIOUS_EVIDENCE DELETION_TIMESTAMP_FILE]",
		);
	const required = (key: string) => {
		const value = process.env[key];
		if (!value) throw new Error(`Set ${key}`);
		return value;
	};
	const read = (name: string) => readFileSync(path.join(directory, name), "utf8");
	const contract = verifyDockerPod(
		JSON.parse(read("pod.json")) as V1Pod,
		JSON.parse(read("pvc.json")) as V1PersistentVolumeClaim,
		JSON.parse(read("pv.json")) as V1PersistentVolume,
		{
			runtimeClass: required("LEITWERK_RUNTIME_CLASS_NAME"),
			storageClass: required("LEITWERK_DOCKER_STORAGE_CLASS_NAME"),
			workerImage: required("LEITWERK_WORKER_IMAGE"),
		},
	);
	const daemon = verifyDockerDaemon(
		JSON.parse(read("docker-info.json")),
		JSON.parse(read("listeners.json")),
	);
	const innerImageId = read("inner-image-id.txt").trim();
	const marker = read("workspace-marker.txt").trim();
	if (!/^sha256:[a-f0-9]{64}$/.test(innerImageId) || !marker)
		throw new Error("Retained image and workspace marker evidence are required");
	const evidence: DockerWorkerEvidence = {
		observedAt: new Date().toISOString(),
		...contract,
		...daemon,
		innerImageId,
		marker,
	};
	if (previousFile) {
		if (!deletionFile)
			throw new Error("Replacement verification requires a confirmed deletion timestamp");
		const previous = JSON.parse(readFileSync(previousFile, "utf8")) as DockerWorkerEvidence;
		const deletedAt = readFileSync(deletionFile, "utf8").trim();
		verifyDockerRetention(previous, evidence, deletedAt);
		evidence.replacesPodUid = previous.podUid;
		evidence.previousPodDeletedAt = deletedAt;
	}
	writeFileSync(path.join(directory, "evidence.json"), `${JSON.stringify(evidence, null, 2)}\n`, {
		mode: 0o600,
	});
	console.info(
		`Docker worker verified: ${evidence.podUid}, PVC ${evidence.pvcUid}, retained image ${evidence.innerImageId}`,
	);
} catch (error) {
	console.error(error instanceof Error ? error.message : "Docker worker verification failed");
	process.exitCode = 1;
}
