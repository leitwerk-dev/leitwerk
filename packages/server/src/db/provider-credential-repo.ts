import { and, count, eq } from "drizzle-orm";
import type { CredentialCipher } from "./credential-cipher.js";
import type { LeitwerkDb } from "./database.js";
import { now } from "./repo-helpers.js";
import * as s from "./schema.js";

export interface ProviderCredentialRecord {
	providerId: string;
	revision: number;
	payload: string;
	createdAt: string;
	updatedAt: string;
}

export function createProviderCredentialRepo(db: LeitwerkDb, cipher: CredentialCipher) {
	const row = (value: typeof s.providerCredentials.$inferSelect): ProviderCredentialRecord => ({
		providerId: value.providerId,
		revision: value.revision,
		payload: cipher.decrypt(value.encryptedPayload),
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	});
	return {
		count(): number {
			return db.select({ value: count() }).from(s.providerCredentials).get()?.value ?? 0;
		},
		get(providerId: string): ProviderCredentialRecord | null {
			const value = db
				.select()
				.from(s.providerCredentials)
				.where(eq(s.providerCredentials.providerId, providerId))
				.get();
			return value ? row(value) : null;
		},
		create(input: { providerId: string; payload: string }): ProviderCredentialRecord {
			const ts = now();
			const value = {
				...input,
				revision: 1,
				encryptedPayload: cipher.encrypt(input.payload),
				createdAt: ts,
				updatedAt: ts,
			};
			db.insert(s.providerCredentials).values(value).run();
			return {
				providerId: input.providerId,
				revision: 1,
				payload: input.payload,
				createdAt: ts,
				updatedAt: ts,
			};
		},
		compareAndSet(input: {
			providerId: string;
			expectedRevision: number;
			payload: string;
		}): ProviderCredentialRecord | null {
			const ts = now();
			const revision = input.expectedRevision + 1;
			const result = db
				.update(s.providerCredentials)
				.set({
					revision,
					encryptedPayload: cipher.encrypt(input.payload),
					updatedAt: ts,
				})
				.where(
					and(
						eq(s.providerCredentials.providerId, input.providerId),
						eq(s.providerCredentials.revision, input.expectedRevision),
					),
				)
				.run();
			if (result.changes !== 1) return null;
			return this.get(input.providerId);
		},
	};
}
