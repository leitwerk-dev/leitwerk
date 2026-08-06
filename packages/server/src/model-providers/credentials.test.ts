import { builtinPiProvider, defineModelProvider } from "@leitwerk-dev/process-sdk";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
	createAes256GcmCredentialCipher,
	createCredentialCipherFromBase64,
	createUnavailableCredentialCipher,
} from "../db/credential-cipher.js";
import { createInMemoryDatabase } from "../db/database.js";
import { createProviderCredentialRepo } from "../db/provider-credential-repo.js";
import * as schema from "../db/schema.js";
import { ownedProviderSet } from "../test-helpers/model-provider-fixtures.js";
import { createModelProviderCredentialService } from "./credentials.js";
import { createModelProviderRegistry } from "./registry.js";

function credentialProvider() {
	return defineModelProvider({
		id: "secret-provider",
		parseConfig: (raw) => {
			const apiKey = (raw as { apiKey?: string } | undefined)?.apiKey;
			return { config: {}, ...(apiKey ? { credential: { apiKey } } : {}) };
		},
		worker: builtinPiProvider("secret-provider"),
		models: ({ configuredModels }) =>
			configuredModels.map(({ modelId }) => ({ modelId, availability: "available" as const })),
		credential: {
			parse(value) {
				if (
					typeof value !== "object" ||
					value === null ||
					Array.isArray(value) ||
					typeof (value as { apiKey?: unknown }).apiKey !== "string"
				) {
					throw new Error("apiKey is required");
				}
				return { apiKey: (value as { apiKey: string }).apiKey };
			},
		},
		secrets: ({ credential }) => ({ apiKey: credential?.apiKey ?? "" }),
	});
}

function fixture() {
	const db = createInMemoryDatabase();
	const definition = credentialProvider();
	const registry = createModelProviderRegistry({
		sets: [ownedProviderSet(definition)],
		piContributions: [],
		extensionConfig: { owner: { apiKey: "configured-secret" } },
		modelProfiles: [],
		titleModelProfileId: null,
	});
	const repo = createProviderCredentialRepo(
		db,
		createAes256GcmCredentialCipher(Buffer.alloc(32, 7)),
	);
	return {
		db,
		repo,
		service: createModelProviderCredentialService({ registry, repo }),
		provider: registry.require("secret-provider"),
	};
}

describe("provider credential service", () => {
	it("initializes encrypted state, resolves a short-lived secret bag, and applies revision CAS", () => {
		const harness = fixture();
		harness.service.initialize();

		expect(harness.service.status(harness.provider)).toEqual({ available: true, revision: 1 });
		expect(harness.service.resolve("secret-provider")).toEqual({
			providerId: "secret-provider",
			revision: 1,
			values: { apiKey: "configured-secret" },
		});
		const encrypted = harness.db
			.select({ payload: schema.providerCredentials.encryptedPayload })
			.from(schema.providerCredentials)
			.where(eq(schema.providerCredentials.providerId, "secret-provider"))
			.get()?.payload;
		expect(encrypted).toBeTruthy();
		expect(encrypted).not.toContain("configured-secret");

		expect(
			harness.service.compareAndSet({
				providerId: "secret-provider",
				expectedRevision: 0,
				value: { apiKey: "stale-secret" },
			}),
		).toEqual({
			accepted: false,
			currentRevision: 1,
			safeReason: "Credential revision changed",
		});
		expect(
			harness.service.compareAndSet({
				providerId: "secret-provider",
				expectedRevision: 1,
				value: { apiKey: "refreshed-secret" },
			}),
		).toEqual({ accepted: true, currentRevision: 2 });
		expect(harness.service.resolve("secret-provider")).toEqual(
			expect.objectContaining({ revision: 2, values: { apiKey: "refreshed-secret" } }),
		);
		harness.service.initialize();
		expect(harness.service.resolve("secret-provider")).toEqual(
			expect.objectContaining({ revision: 2, values: { apiKey: "refreshed-secret" } }),
		);
	});

	it("fails credential reads when encrypted rows exist without the deployment key", () => {
		const harness = fixture();
		harness.service.initialize();
		const unavailableRepo = createProviderCredentialRepo(
			harness.db,
			createUnavailableCredentialCipher(),
		);
		expect(() => unavailableRepo.get("secret-provider")).toThrow(/encryption key is unavailable/);
	});

	it("accepts only exact 32-byte Base64 deployment keys", () => {
		expect(() => createCredentialCipherFromBase64("not-base64")).toThrow(/exactly 32 bytes/);
		expect(() => createCredentialCipherFromBase64(Buffer.alloc(31).toString("base64"))).toThrow(
			/exactly 32 bytes/,
		);
		expect(() =>
			createCredentialCipherFromBase64(Buffer.alloc(32).toString("base64")),
		).not.toThrow();
	});
});
