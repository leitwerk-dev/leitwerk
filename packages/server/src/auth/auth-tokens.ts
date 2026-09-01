import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export type OpaqueTokenHashEncoding = "base64url" | "hex";

export function generateOpaqueToken(byteLength = 32): string {
	return randomBytes(byteLength).toString("base64url");
}

export function createOpaqueToken(): string {
	return generateOpaqueToken();
}

export function hashOpaqueToken(
	token: string,
	encoding: OpaqueTokenHashEncoding = "base64url",
): string {
	return createHash("sha256").update(token, "utf8").digest(encoding);
}

export function verifyOpaqueToken(
	token: string,
	expectedHash: string,
	encoding: OpaqueTokenHashEncoding = "base64url",
): boolean {
	const actual = Buffer.from(hashOpaqueToken(token, encoding), encoding);
	const expected = Buffer.from(expectedHash, encoding);
	return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isoFromNow(ms: number, now = new Date()): string {
	return new Date(now.getTime() + ms).toISOString();
}
