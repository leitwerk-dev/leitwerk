import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Application boundary for encrypted credential payloads. Callers supply deployment key material. */
export interface CredentialCipher {
	encrypt(plaintext: string): string;
	decrypt(ciphertext: string): string;
}

export const PROVIDER_CREDENTIAL_KEY_ENV = "LEITWERK_CREDENTIAL_ENCRYPTION_KEY";

/** A missing deployment key may inspect an empty table but can never read or write credentials. */
export function createUnavailableCredentialCipher(): CredentialCipher {
	const unavailable = (): never => {
		throw new Error(
			`Provider credential encryption key is unavailable; set ${PROVIDER_CREDENTIAL_KEY_ENV}`,
		);
	};
	return { encrypt: unavailable, decrypt: unavailable };
}

/** Parses an exact 32-byte Base64 deployment secret. */
export function createCredentialCipherFromBase64(value: string): CredentialCipher {
	const normalized = value.trim();
	if (normalized === "") {
		throw new Error(`${PROVIDER_CREDENTIAL_KEY_ENV} must not be empty`);
	}
	const key = Buffer.from(normalized, "base64");
	if (
		key.length !== 32 ||
		key.toString("base64").replace(/=+$/, "") !== normalized.replace(/=+$/, "")
	) {
		throw new Error(`${PROVIDER_CREDENTIAL_KEY_ENV} must be Base64 for exactly 32 bytes`);
	}
	return createAes256GcmCredentialCipher(key);
}

export function createCredentialCipherFromEnvironment(
	environment: NodeJS.ProcessEnv = process.env,
): CredentialCipher | null {
	const value = environment[PROVIDER_CREDENTIAL_KEY_ENV];
	return value === undefined ? null : createCredentialCipherFromBase64(value);
}

export function createAes256GcmCredentialCipher(key: Buffer): CredentialCipher {
	if (key.length !== 32) throw new Error("Credential encryption key must be 32 bytes");
	return {
		encrypt(plaintext) {
			const iv = randomBytes(12);
			const cipher = createCipheriv("aes-256-gcm", key, iv);
			const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
			return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
		},
		decrypt(ciphertext) {
			const bytes = Buffer.from(ciphertext, "base64");
			if (bytes.length < 29) throw new Error("Invalid encrypted credential payload");
			const decipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(0, 12));
			decipher.setAuthTag(bytes.subarray(12, 28));
			return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString(
				"utf8",
			);
		},
	};
}
