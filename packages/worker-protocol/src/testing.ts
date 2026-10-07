import type { ConfigSnapshot } from "@leitwerk-dev/protocol/config-snapshot";
import { IPC_PROTOCOL_VERSION } from "./ipc-codec.js";

/** @internal */
export async function flushAsyncWork(iterations = 30): Promise<void> {
	for (let i = 0; i < iterations; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

/** @internal */
export function createTestIpcEnvelopeBase(instanceId: string, workerId: string, messageId: string) {
	return {
		/** @internal */
		protocol: IPC_PROTOCOL_VERSION as typeof IPC_PROTOCOL_VERSION,
		/** @internal */
		messageId,
		/** @internal */
		instanceId,
		/** @internal */
		workerId,
		/** @internal */
		sentAt: new Date().toISOString(),
	};
}

/** @internal */
export function createTestConfigSnapshot(): ConfigSnapshot {
	return {
		workers: {
			heartbeat_interval: "5s",
			turn_max_duration: "30m",
			turn_inactivity_timeout: "5m",
			turn_abort_grace_period: "5s",
		},
		pi: {
			agent_dir: "~/.pi/leitwerk",
			model_profiles: [],
			process_title_generation: {
				model_profile: null,
				retry: {
					max_attempts: 6,
					base_delay: "5s",
					max_delay: "5m",
				},
			},
			retry: {
				enabled: true,
				max_retries: 3,
				base_delay: "2s",
				provider: {
					timeout: null,
					max_retries: null,
					max_retry_delay: "60s",
				},
			},
		},
	};
}
