import type {
	V1Container,
	V1EphemeralContainer,
	V1PersistentVolume,
	V1PersistentVolumeClaim,
	V1Pod,
	V1Volume,
	V1VolumeMount,
} from "@kubernetes/client-node";
export const expected = {
	runtimeClass: "example-runtime",
	storageClass: "example-csi",
	workerImage: "registry.example/worker@sha256:abcd",
};
export function fixture() {
	const pod = {
		metadata: { name: "worker", uid: "pod-1", namespace: "example" },
		spec: {
			nodeName: "node-a",
			runtimeClassName: expected.runtimeClass,
			hostUsers: false,
			hostNetwork: false,
			hostIPC: false,
			hostPID: false,
			initContainers: [] as V1Container[],
			ephemeralContainers: [] as V1EphemeralContainer[],
			containers: [
				{
					name: "worker",
					image: expected.workerImage,
					volumeMounts: [{ name: "state", mountPath: "/state" }] as V1VolumeMount[],
				},
			],
			volumes: [{ name: "state", persistentVolumeClaim: { claimName: "state" } }] as V1Volume[],
		},
		status: {
			phase: "Running",
			conditions: [{ type: "Ready", status: "True" }],
			containerStatuses: [
				{
					name: "worker",
					ready: true,
					image: expected.workerImage,
					imageID: "containerd://sha256:abcd",
					restartCount: 0,
				},
			],
		},
	} satisfies V1Pod;
	const pvc = {
		metadata: { name: "state", uid: "pvc-1", namespace: "example" },
		spec: { storageClassName: expected.storageClass, volumeName: "pv-a" },
		status: { phase: "Bound" },
	} satisfies V1PersistentVolumeClaim;
	const pv = {
		metadata: { name: "pv-a", uid: "pv-1" },
		spec: {
			claimRef: { name: "state", namespace: "example", uid: "pvc-1" },
			csi: { driver: "example.csi", volumeHandle: "volume-a" },
		},
	} satisfies V1PersistentVolume;
	return { pod, pvc, pv };
}
