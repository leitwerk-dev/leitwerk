import type { ProcessRetryConfig } from "@leitwerk-dev/protocol/http-contracts";

export type PendingRetryConfig = ProcessRetryConfig;

let pendingRetryConfig: PendingRetryConfig | null = $state(null);

export function setPendingRetryConfig(config: PendingRetryConfig | null): void {
	pendingRetryConfig = config;
}

export function consumePendingRetryConfig(): PendingRetryConfig | null {
	const config = pendingRetryConfig;
	pendingRetryConfig = null;
	return config;
}

export function hasPendingRetryConfig(): boolean {
	return pendingRetryConfig !== null;
}
