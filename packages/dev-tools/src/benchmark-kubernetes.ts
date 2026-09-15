import { execFileSync } from "node:child_process";

export interface KubernetesEvidenceOptions {
	namespace: string;
	deployment: string;
	kubeconfig?: string;
	expectedServerImage?: string;
}

/** Optional, read-only evidence from a caller-selected deployment. */
export function kubernetesEvidence(options: KubernetesEvidenceOptions): unknown {
	if (!options.namespace.trim() || !options.deployment.trim())
		throw new Error("Kubernetes evidence requires a namespace and deployment");
	const read = (resource: string, args: string[]) => {
		try {
			return JSON.parse(
				execFileSync(
					"kubectl",
					[
						...(options.kubeconfig ? ["--kubeconfig", options.kubeconfig] : []),
						"--request-timeout=15s",
						"-n",
						options.namespace,
						"get",
						resource,
						...args,
						"-o",
						"json",
					],
					{ encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] },
				),
			);
		} catch {
			throw new Error(`Cannot collect Kubernetes ${resource} evidence`);
		}
	};
	const deployment = read("deployment", [options.deployment]);
	const selector = deployment.spec?.selector?.matchLabels;
	if (!selector || !Object.keys(selector).length)
		throw new Error("Deployment has no matchLabels selector");
	const images = deployment.spec.template.spec.containers.map(
		(container: { name: string; image: string }) => ({
			name: container.name,
			image: container.image,
		}),
	);
	if (
		options.expectedServerImage &&
		!images.some((entry: { image: string }) => entry.image === options.expectedServerImage)
	)
		throw new Error("Deployment does not use the expected server image");
	const pods = read("pods", [
		"-l",
		Object.entries(selector)
			.map(([key, value]) => `${key}=${value}`)
			.join(","),
	]);
	return {
		observedAt: new Date().toISOString(),
		namespace: options.namespace,
		deployment: options.deployment,
		deploymentUid: deployment.metadata.uid,
		serverImages: images,
		annotations: Object.fromEntries(
			Object.entries(deployment.spec.template.metadata?.annotations ?? {}).filter(([key]) =>
				key.startsWith("leitwerk.dev/"),
			),
		),
		serverImageIds: pods.items.flatMap(
			(pod: {
				metadata: { name: string; uid: string };
				status?: { containerStatuses?: { name: string; imageID?: string }[] };
			}) =>
				(pod.status?.containerStatuses ?? []).map((container) => ({
					pod: pod.metadata.name,
					podUid: pod.metadata.uid,
					name: container.name,
					imageId: container.imageID ?? null,
				})),
		),
	};
}
