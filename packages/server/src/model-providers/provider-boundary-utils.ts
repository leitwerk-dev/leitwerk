import type { ProviderCredentialStatus } from "@leitwerk-dev/process-sdk";

export function positiveBound(value: number | undefined, fallback: number, name: string): number {
	const resolved = value ?? fallback;
	if (!Number.isSafeInteger(resolved) || resolved < 1) {
		throw new Error(`${name} must be a positive safe integer`);
	}
	return resolved;
}

export async function withTimeout<T>(
	work: Promise<T>,
	timeoutMs: number,
	sentinelMessage: string = "timeout",
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			work,
			new Promise<T>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(sentinelMessage)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

export function validateCredentialStatus(
	value: ProviderCredentialStatus,
	message: string = "invalid credential status",
): ProviderCredentialStatus {
	if (
		typeof value !== "object" ||
		value === null ||
		typeof value.available !== "boolean" ||
		!(value.revision === null || (Number.isSafeInteger(value.revision) && value.revision >= 0))
	) {
		throw new Error(message);
	}
	return value;
}
