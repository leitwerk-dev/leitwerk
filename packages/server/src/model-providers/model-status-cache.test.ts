import { builtinPiProvider, defineModelProvider } from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { ownedProviderSet } from "../test-helpers/model-provider-fixtures.js";
import { createModelStatusCache } from "./model-status-cache.js";
import { createModelProviderRegistry, defaultModelProviderCredentialStatus } from "./registry.js";

function fixture(models: ReturnType<typeof vi.fn>) {
	const provider = defineModelProvider({
		id: "provider",
		parseConfig: () => ({ config: { region: "test" } }),
		worker: builtinPiProvider("provider"),
		server: builtinPiProvider("provider"),
		models,
		secrets: () => ({}),
	});
	const profiles = [
		{ id: "fast", provider: "provider", model_id: "model-a" },
		{ id: "slow", provider: "provider", model_id: "model-b" },
	];
	const registry = createModelProviderRegistry({
		sets: [ownedProviderSet(provider)],
		piContributions: [],
		extensionConfig: { owner: {} },
		modelProfiles: profiles,
		titleModelProfileId: null,
	});
	return { registry, profiles };
}

describe("model status cache", () => {
	it("publishes bounded statuses with timestamps and a revision", async () => {
		const models = vi.fn(() => [
			{ modelId: "model-a", availability: "available" as const },
			{
				modelId: "model-b",
				availability: "unavailable" as const,
				safeReason: "Capacity is unavailable",
			},
		]);
		const { registry, profiles } = fixture(models);
		const cache = createModelStatusCache({
			registry,
			modelProfiles: profiles,
			credentialStatus: () => ({ available: true, revision: 2 }),
			now: () => new Date("2026-07-22T10:00:00.000Z"),
			ttlMs: 1_000,
		});

		const snapshot = await cache.refresh();
		expect(snapshot.revision).toBe(1);
		expect(snapshot.profiles).toEqual([
			expect.objectContaining({
				profileId: "fast",
				availability: "available",
				checkedAt: "2026-07-22T10:00:00.000Z",
				expiresAt: "2026-07-22T10:00:01.000Z",
			}),
			expect.objectContaining({
				profileId: "slow",
				availability: "unavailable",
				safeReason: "Capacity is unavailable",
			}),
		]);
		expect(models).toHaveBeenCalledWith({
			config: { region: "test" },
			credentialStatus: { available: true, revision: 2 },
			configuredModels: [
				{ profileId: "fast", modelId: "model-a" },
				{ profileId: "slow", modelId: "model-b" },
			],
		});
	});

	it("keeps missing-credential profiles visible and unavailable", async () => {
		const models = vi.fn(() => []);
		const { registry, profiles } = fixture(models);
		const cache = createModelStatusCache({
			registry,
			modelProfiles: profiles,
			credentialStatus: () => ({ available: false, revision: null }),
		});

		const snapshot = await cache.refresh();
		expect(snapshot.profiles.map((profile) => profile.availability)).toEqual([
			"unavailable",
			"unavailable",
		]);
		expect(snapshot.profiles[0]?.safeReason).toMatch(/credentials/i);
		expect(models).not.toHaveBeenCalled();
	});

	it("defaults credentialless providers available and persisted-credential providers unavailable", async () => {
		const credentiallessModels = vi.fn(() => [
			{ modelId: "model-a", availability: "available" as const },
			{ modelId: "model-b", availability: "available" as const },
		]);
		const credentialless = fixture(credentiallessModels);
		const credentiallessCache = createModelStatusCache({
			registry: credentialless.registry,
			modelProfiles: credentialless.profiles,
			credentialStatus: defaultModelProviderCredentialStatus,
		});
		expect((await credentiallessCache.refresh()).profiles[0]?.availability).toBe("available");
		expect(credentiallessModels).toHaveBeenCalledOnce();

		const credentialedModels = vi.fn(() => [
			{ modelId: "model-a", availability: "available" as const },
			{ modelId: "model-b", availability: "available" as const },
		]);
		const definition = defineModelProvider({
			id: "credentialed",
			parseConfig: () => ({ config: {} }),
			worker: builtinPiProvider("credentialed"),
			models: credentialedModels,
			secrets: () => ({}),
			credential: {},
		});
		const profiles = [{ id: "secured", provider: "credentialed", model_id: "model-a" }];
		const registry = createModelProviderRegistry({
			sets: [ownedProviderSet(definition)],
			piContributions: [],
			extensionConfig: {},
			modelProfiles: profiles,
			titleModelProfileId: null,
		});
		const credentialedCache = createModelStatusCache({
			registry,
			modelProfiles: profiles,
			credentialStatus: defaultModelProviderCredentialStatus,
		});
		expect((await credentialedCache.refresh()).profiles[0]?.availability).toBe("unavailable");
		expect(credentialedModels).not.toHaveBeenCalled();
	});

	it("turns provider failures and timeouts into safe stale states", async () => {
		const thrown = fixture(vi.fn(() => Promise.reject(new Error("secret token abc"))));
		const failed = createModelStatusCache({
			registry: thrown.registry,
			modelProfiles: thrown.profiles,
			credentialStatus: () => ({ available: true, revision: 1 }),
		});
		expect((await failed.refresh()).profiles[0]).toEqual(
			expect.objectContaining({
				availability: "stale",
				safeReason: "Provider model status refresh failed",
			}),
		);

		const timed = fixture(vi.fn(() => new Promise(() => {})));
		const timeout = createModelStatusCache({
			registry: timed.registry,
			modelProfiles: timed.profiles,
			credentialStatus: () => ({ available: true, revision: 1 }),
			timeoutMs: 2,
		});
		expect((await timeout.refresh()).profiles[0]?.safeReason).toMatch(/timed out/);
	});

	it("advances revision only for observable changes and reports restoration transitions", async () => {
		let availability: "available" | "unavailable" = "unavailable";
		const { registry, profiles } = fixture(
			vi.fn(() => [
				{ modelId: "model-a", availability },
				{ modelId: "model-b", availability: "available" as const },
			]),
		);
		let nowMs = Date.parse("2026-07-22T10:00:00.000Z");
		const cache = createModelStatusCache({
			registry,
			modelProfiles: profiles,
			credentialStatus: () => ({ available: true, revision: 1 }),
			now: () => new Date(nowMs),
		});
		const first = await cache.refresh();
		expect(first.revision).toBe(1);
		nowMs += 1_000;
		expect((await cache.refresh()).revision).toBe(1);
		availability = "available";
		const restored = await cache.refresh();
		expect(restored.revision).toBe(2);
		expect(restored.availabilityTransitions).toContainEqual({
			profileId: "fast",
			from: "unavailable",
			to: "available",
		});
		expect(cache.snapshot().availabilityTransitions).toEqual([]);
	});

	it("expires a current status to stale and advances the revision", async () => {
		const { registry, profiles } = fixture(
			vi.fn(() => [
				{ modelId: "model-a", availability: "available" as const },
				{ modelId: "model-b", availability: "available" as const },
			]),
		);
		let nowMs = Date.parse("2026-07-22T10:00:00.000Z");
		const cache = createModelStatusCache({
			registry,
			modelProfiles: profiles,
			credentialStatus: () => ({ available: true, revision: 1 }),
			ttlMs: 100,
			now: () => new Date(nowMs),
		});
		expect((await cache.refresh()).revision).toBe(1);
		nowMs += 101;
		const expired = cache.snapshot();
		expect(expired.revision).toBe(2);
		expect(expired.profiles[0]?.availability).toBe("stale");
		expect(expired.profiles[0]?.safeReason).toBe("Model status expired");
	});
});
