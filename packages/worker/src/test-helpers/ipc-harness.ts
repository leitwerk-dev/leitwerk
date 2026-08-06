import { createTestConfigSnapshot, IPC_PROTOCOL_VERSION } from "@leitwerk-dev/worker-protocol";

export async function flushAsyncWork(iterations = 30): Promise<void> {
	for (let i = 0; i < iterations; i++) {
		await new Promise<void>((resolve) => setImmediate(resolve));
	}
}

export const testConfigSnapshot = createTestConfigSnapshot;

export function baseEnvelope(instanceId: string, workerId: string, messageId: string) {
	return {
		protocol: IPC_PROTOCOL_VERSION as typeof IPC_PROTOCOL_VERSION,
		messageId,
		instanceId,
		workerId,
		sentAt: new Date().toISOString(),
	};
}
