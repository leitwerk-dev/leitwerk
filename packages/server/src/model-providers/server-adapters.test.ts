import {
	builtinPiProvider,
	defineModelProvider,
	definePiServerAdapter,
	piServer,
	piWorker,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { ownedProviderSet } from "../test-helpers/model-provider-fixtures.js";
import type { ModelProviderCredentialService } from "./credentials.js";
import { createModelProviderRegistry } from "./registry.js";
import { createModelProviderServerAdapterRegistry } from "./server-adapters.js";

function credentials(): ModelProviderCredentialService & { secret: string } {
	return {
		secret: "first",
		initialize() {},
		status: () => ({ available: true, revision: 1 }),
		resolve(providerId) {
			return { providerId, revision: 1, values: { token: this.secret } };
		},
		compareAndSet: () => ({ accepted: false, currentRevision: 1 }),
	};
}

describe("model provider server adapters", () => {
	it("loads built-in adapters and resolves the current credential for every attempt", async () => {
		const definition = defineModelProvider({
			id: "provider",
			parseConfig: () => ({ config: { endpoint: "test" } }),
			worker: builtinPiProvider("provider"),
			server: builtinPiProvider("provider"),
			models: () => [],
			secrets: ({ credential }) => credential as Record<string, string>,
		});
		const registry = createModelProviderRegistry({
			sets: [ownedProviderSet(definition)],
			piContributions: [],
			extensionConfig: { owner: {} },
			modelProfiles: [{ id: "title", provider: "provider", model_id: "model" }],
			titleModelProfileId: "title",
		});
		const credentialService = credentials();
		const generateText = vi.fn(async (request) => request.secrets.token);
		const adapters = await createModelProviderServerAdapterRegistry({
			registry,
			modelProfiles: [{ id: "title", provider: "provider", model_id: "model" }],
			credentials: credentialService,
			createBuiltinAdapter: () => definePiServerAdapter({ generateText }),
		});

		const request = {
			profileId: "title",
			prompt: "prompt",
			systemPrompt: "system",
			maxTokens: 48,
			request: { maxRetryDelayMs: 1_000 },
		};
		expect(await adapters.generateText(request)).toBe("first");
		credentialService.secret = "second";
		expect(await adapters.generateText(request)).toBe("second");
		expect(generateText).toHaveBeenLastCalledWith(
			expect.objectContaining({
				providerId: "provider",
				modelId: "model",
				secrets: { token: "second" },
				config: { endpoint: "test" },
			}),
		);
	});

	it("loads an extension adapter only from the owning declared server entry", async () => {
		const definition = defineModelProvider({
			id: "extension-provider",
			parseConfig: () => ({ config: {} }),
			worker: piWorker(),
			server: piServer(),
			models: () => [],
			secrets: () => ({}),
		});
		const registry = createModelProviderRegistry({
			sets: [ownedProviderSet(definition)],
			piContributions: [
				{
					ownerExtensionId: "owner",
					packageName: "@test/owner",
					workerEntryPath: "/owned/worker.js",
					serverEntryPath: "/owned/server.js",
					resources: { skillDirectories: [], promptDirectories: [] },
				},
			],
			extensionConfig: {},
			modelProfiles: [],
			titleModelProfileId: null,
		});
		const load = vi.fn(async () =>
			definePiServerAdapter({ generateText: async () => "extension" }),
		);
		const adapters = await createModelProviderServerAdapterRegistry({
			registry,
			modelProfiles: [],
			credentials: credentials(),
			createBuiltinAdapter: () => {
				throw new Error("not builtin");
			},
			loadExtensionAdapter: load,
		});
		expect(adapters.get("extension-provider")).not.toBeNull();
		expect(load).toHaveBeenCalledWith("/owned/server.js");
	});
});
