import { WORKER_API_VERSION, type WorkerHelloPayload } from "@leitwerk-dev/worker-protocol";

export interface WorkerApiCompatibilityResult {
	ok: boolean;
	error?: string;
}

export function checkWorkerApiCompatibility(
	payload: WorkerHelloPayload,
	expectedApiVersion = WORKER_API_VERSION,
	options: { requireApiVersion?: boolean } = {},
): WorkerApiCompatibilityResult {
	if (payload.apiVersion === undefined) {
		if (options.requireApiVersion === true) {
			return {
				ok: false,
				error: `Worker API version is required, but none was reported; server API version is '${expectedApiVersion}'`,
			};
		}
		return { ok: true };
	}
	if (payload.apiVersion === expectedApiVersion) {
		return { ok: true };
	}
	return {
		ok: false,
		error: `Worker API version '${payload.apiVersion}' is incompatible with server API version '${expectedApiVersion}'`,
	};
}
