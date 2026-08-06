import { createHash, randomBytes } from "node:crypto";

export function generateOpaqueToken(byteLength = 32): string {
	return randomBytes(byteLength).toString("base64url");
}

export function hashOpaqueToken(token: string): string {
	return createHash("sha256").update(token, "utf8").digest("base64url");
}

export function isoFromNow(ms: number, now = new Date()): string {
	return new Date(now.getTime() + ms).toISOString();
}
