import { setTimeout as delay } from "node:timers/promises";
import type { VolumePoolOptions } from "./kubernetes-volume-pool.js";
import type { PoolObject } from "./kubernetes-volume-pool-api.js";

/** Shared inert preparation workload; callers supply ownership and placement constraints. @internal */
export function buildPreparationPodSpec(
	options: Pick<
		VolumePoolOptions,
		"image" | "imagePullPolicy" | "imagePullSecrets" | "nodeSelector" | "tolerations"
	>,
	volumeMounts?: unknown[],
): PoolObject["spec"] {
	return {
		restartPolicy: "Never",
		serviceAccountName: "default",
		automountServiceAccountToken: false,
		nodeSelector: options.nodeSelector ?? {},
		tolerations: options.tolerations ?? [],
		imagePullSecrets: (options.imagePullSecrets ?? []).map((name) => ({ name })),
		containers: [
			{
				name: "prepare",
				image: options.image,
				imagePullPolicy: options.imagePullPolicy ?? "IfNotPresent",
				command: ["node", "-e", "process.exit(0)"],
				resources: {
					requests: { cpu: "1m", memory: "32Mi" },
					limits: { cpu: "100m", memory: "64Mi" },
				},
				securityContext: {
					allowPrivilegeEscalation: false,
					readOnlyRootFilesystem: true,
					capabilities: { drop: ["ALL"] },
				},
				...(volumeMounts ? { volumeMounts } : {}),
			},
		],
	};
}

/** @internal */
export interface PreparationController {
	/** @internal */
	start(): void;
	/** @internal */
	stop(): Promise<void>;
}

/** One non-overlapping loop; stopping cancels and joins its current work. @internal */
export function createPreparationController(
	reconcile: (signal: AbortSignal) => Promise<void>,
	intervalMs: number,
	onError?: () => void,
	errorIntervalMs = intervalMs,
): PreparationController {
	let controller: AbortController | undefined;
	let running: Promise<void> | undefined;
	return {
		start() {
			if (controller) return;
			controller = new AbortController();
			const { signal } = controller;
			running = (async () => {
				while (!signal.aborted) {
					let interval = intervalMs;
					try {
						await reconcile(signal);
					} catch {
						interval = errorIntervalMs;
						if (!signal.aborted) onError?.();
					}
					try {
						await delay(interval, undefined, { signal });
					} catch {
						break;
					}
				}
			})();
		},
		async stop() {
			controller?.abort();
			await running;
			controller = undefined;
		},
	};
}

/** Controllers own separate asynchronous reconciliation loops. @internal */
export function createKubernetesPreparation(controllers: PreparationController[]) {
	return {
		/** @internal */
		start() {
			for (const controller of controllers) controller.start();
		},
		/** @internal */
		async stop() {
			await Promise.allSettled(controllers.map((controller) => controller.stop()));
		},
	};
}
