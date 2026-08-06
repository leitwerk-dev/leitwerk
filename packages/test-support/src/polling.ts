export async function waitForValue<T>(
	read: () => T,
	predicate: (value: T) => boolean,
	timeoutMs = 5_000,
): Promise<T> {
	const deadline = Date.now() + timeoutMs;
	while (true) {
		const value = read();
		if (predicate(value)) {
			return value;
		}
		if (Date.now() >= deadline) {
			throw new Error("Timed out waiting for value");
		}
		await new Promise((resolve) => setTimeout(resolve, 25));
	}
}
