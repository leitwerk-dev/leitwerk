import { describe, expect, it } from "vitest";
import { expected, fixture } from "./test-fixture.ts";
import {
	type DockerWorkerEvidence,
	verifyDockerDaemon,
	verifyDockerPod,
	verifyDockerRetention,
} from "./verification.ts";

describe("Docker worker verification", () => {
	it("accepts a selected CSI volume without a local storage path or fixed node policy", () => {
		const { pod, pvc, pv } = fixture();
		expect(verifyDockerPod(pod, pvc, pv, expected)).toMatchObject({
			podUid: "pod-1",
			pvcUid: "pvc-1",
			pvUid: "pv-1",
			workerImageId: "containerd://sha256:abcd",
		});
	});
	it.each([
		"containers",
		"initContainers",
		"ephemeralContainers",
	] as const)("rejects privileges, capabilities and socket mounts in %s", (kind) => {
		for (const unsafe of [
			{ securityContext: { privileged: true } },
			{ securityContext: { capabilities: { add: ["NET_ADMIN"] } } },
			{ volumeMounts: [{ name: "socket", mountPath: "/var/run/docker.sock" }] },
		]) {
			const { pod, pvc, pv } = fixture();
			pod.spec[kind].push({ name: "extra", ...unsafe });
			expect(() => verifyDockerPod(pod, pvc, pv, expected)).toThrow(
				/privileged|capabilities|runtime sockets/,
			);
		}
	});
	it.each(["hostNetwork", "hostPID", "hostIPC"] as const)("rejects %s", (field) => {
		const { pod, pvc, pv } = fixture();
		pod.spec[field] = true;
		expect(() => verifyDockerPod(pod, pvc, pv, expected)).toThrow("host namespaces");
	});
	it("rejects hostPath volumes and a different physical PVC behind the same name", () => {
		const { pod, pvc, pv } = fixture();
		pod.spec.volumes.push({ name: "host", hostPath: { path: "/" } });
		expect(() => verifyDockerPod(pod, pvc, pv, expected)).toThrow("hostPath");
		pod.spec.volumes.pop();
		pvc.metadata.uid = "replacement-pvc";
		expect(() => verifyDockerPod(pod, pvc, pv, expected)).toThrow("PV claim identity");
	});
	it.each(["subpath", "read-only claim"])("rejects a %s for /state", (kind) => {
		const { pod, pvc, pv } = fixture();
		if (kind === "subpath") pod.spec.containers[0].volumeMounts[0].subPath = "other-state";
		else
			pod.spec.volumes[0].persistentVolumeClaim = {
				claimName: pvc.metadata.name,
				readOnly: true,
			};
		expect(() => verifyDockerPod(pod, pvc, pv, expected)).toThrow("complete writable process PVC");
	});
	it("verifies overlay2, persistent daemon data and listener evidence", () => {
		const info = {
			Driver: "overlay2",
			DockerRootDir: "/state/tooling/docker",
			ServerVersion: "example-version",
		};
		expect(verifyDockerDaemon(info, [8080])).toMatchObject({
			driver: "overlay2",
			dockerVersion: "example-version",
		});
		expect(() => verifyDockerDaemon({ ...info, Driver: "vfs" }, [])).toThrow("overlay2");
		expect(() => verifyDockerDaemon({ ...info, DockerRootDir: "/tmp/docker" }, [])).toThrow(
			"/state/tooling/docker",
		);
		for (const port of [2375, 2376])
			expect(() => verifyDockerDaemon(info, [port])).toThrow("Docker TCP ports");
	});
	it("requires physical replacement after confirmed deletion while retaining storage, images and workspace", () => {
		const { pod, pvc, pv } = fixture();
		const before: DockerWorkerEvidence = {
			observedAt: "2026-09-15T00:00:00Z",
			...verifyDockerPod(pod, pvc, pv, expected),
			...verifyDockerDaemon({ Driver: "overlay2", DockerRootDir: "/state/tooling/docker" }, []),
			innerImageId: "sha256:inner",
			marker: "retained-marker",
		};
		const after = { ...before, observedAt: "2026-09-15T00:00:02Z", podUid: "pod-2" };
		const deletedAt = "2026-09-15T00:00:01Z";
		expect(() => verifyDockerRetention(before, after, deletedAt)).not.toThrow();
		expect(() =>
			verifyDockerRetention(before, { ...after, podUid: before.podUid }, deletedAt),
		).toThrow("different physical Pod");
		for (const field of ["pvcUid", "pvUid", "workerImageId", "innerImageId", "marker"] as const)
			expect(() =>
				verifyDockerRetention(before, { ...after, [field]: "changed" }, deletedAt),
			).toThrow(`retain ${field}`);
		expect(() => verifyDockerRetention(before, after, "2026-09-15T00:00:03Z")).toThrow(
			"confirmed Pod deletion",
		);
	});
});
