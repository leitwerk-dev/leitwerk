import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function createWorkerConnectToken(): string {
	return randomBytes(32).toString("base64url");
}

export function hashWorkerConnectToken(token: string): string {
	return createHash("sha256").update(token).digest("hex");
}

export function verifyWorkerConnectToken(token: string, expectedHash: string): boolean {
	const actual = Buffer.from(hashWorkerConnectToken(token), "hex");
	const expected = Buffer.from(expectedHash, "hex");
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}
