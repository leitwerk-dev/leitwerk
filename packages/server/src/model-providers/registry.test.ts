import type { CatalogPiContribution, OwnedModelProviderSet } from "@leitwerk-dev/extension-runtime";
import {
	builtinPiProvider,
	defineModelProvider,
	defineProviderOptions,
	piServer,
	piWorker,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it, vi } from "vitest";
import { ownedProviderSet } from "../test-helpers/model-provider-fixtures.js";
import { createModelProviderRegistry } from "./registry.js";

const owned = (ownerExtensionId: string, definition: ReturnType<typeof builtinProvider>) =>
	ownedProviderSet(definition, ownerExtensionId);

function builtinProvider(id: string, overrides: Record<string, unknown> = {}) {
	return defineModelProvider({
		id,
		parseConfig: (raw) => ({ config: raw ?? {} }),
		worker: builtinPiProvider(id),
		server: builtinPiProvider(id),
		models: () => [],
		secrets: () => ({}),
		...overrides,
	});
}

function create(input: {
	definitions?: readonly OwnedModelProviderSet[];
	piContributions?: readonly CatalogPiContribution[];
	extensionConfig?: Record<string, unknown>;
	modelProfiles?: Array<{
		id: string;
		provider: string;
		model_id: string;
		provider_options?: Record<string, string>;
	}>;
	titleModelProfileId?: string | null;
}) {
	return createModelProviderRegistry({
		sets: input.definitions ?? [],
		piContributions: input.piContributions ?? [],
		extensionConfig: input.extensionConfig ?? {},
		modelProfiles: input.modelProfiles ?? [],
		titleModelProfileId: input.titleModelProfileId ?? null,
	});
}

describe("model provider registry", () => {
	it("parses owner-scoped configuration once and returns ordered lookup", () => {
		const parseA = vi.fn((raw: unknown) => ({ config: { raw } }));
		const parseB = vi.fn((raw: unknown) => ({ config: { raw } }));
		const registry = create({
			definitions: [
				owned("a", builtinProvider("provider-a", { parseConfig: parseA })),
				owned("b", builtinProvider("provider-b", { parseConfig: parseB })),
			],
			extensionConfig: { a: { endpoint: "a" }, b: { endpoint: "b" } },
		});

		expect(parseA).toHaveBeenCalledOnce();
		expect(parseA).toHaveBeenCalledWith({ endpoint: "a" });
		expect(parseB).toHaveBeenCalledWith({ endpoint: "b" });
		expect(registry.list().map((provider) => provider.id)).toEqual(["provider-a", "provider-b"]);
		expect(registry.get("provider-a")?.config).toEqual({ raw: { endpoint: "a" } });
	});

	it("separates configured credentials from callback-visible provider config", () => {
		const provider = defineModelProvider({
			id: "secured",
			parseConfig: () => ({
				config: { endpoint: "https://provider.invalid" },
				credential: { token: "configured-secret" },
			}),
			credential: {
				parse(value) {
					return value as { token: string };
				},
			},
			worker: builtinPiProvider("secured"),
			models: () => [],
			secrets: ({ credential }) => credential ?? {},
		});
		const registered = create({ definitions: [owned("owner", provider)] }).require("secured");

		expect(registered.config).toEqual({ endpoint: "https://provider.invalid" });
		expect(registered.config).not.toHaveProperty("token");
		expect(registered.configuredCredential).toEqual({ token: "configured-secret" });
	});

	it("rejects duplicate ids and configured profiles with unknown providers", () => {
		expect(() =>
			create({
				definitions: [owned("a", builtinProvider("same")), owned("b", builtinProvider("same"))],
			}),
		).toThrow(/Duplicate model provider id 'same'.*'a'.*'b'/);

		expect(() =>
			create({
				modelProfiles: [{ id: "profile", provider: "missing", model_id: "model" }],
			}),
		).toThrow(/Model profile 'profile' names unknown provider 'missing'/);
	});

	it("requires a server adapter for the title profile", () => {
		const workerOnly = defineModelProvider({
			id: "worker-only",
			parseConfig: () => ({ config: {} }),
			worker: builtinPiProvider("worker-only"),
			models: () => [],
			secrets: () => ({}),
		});
		expect(() =>
			create({
				definitions: [owned("owner", workerOnly)],
				modelProfiles: [{ id: "title-profile", provider: "worker-only", model_id: "model" }],
				titleModelProfileId: "title-profile",
			}),
		).toThrow(/has no server adapter/);
	});

	it("resolves extension Pi references only against their owning contribution", () => {
		const provider = defineModelProvider({
			id: "extension-provider",
			parseConfig: () => ({ config: {} }),
			worker: piWorker(),
			server: piServer(),
			models: () => [],
			secrets: () => ({}),
		});
		const definition = owned("owner", provider);
		expect(() => create({ definitions: [definition] })).toThrow(/declared Pi worker entry/);
		expect(() =>
			create({
				definitions: [definition],
				piContributions: [
					{
						ownerExtensionId: "owner",
						packageName: "@test/owner",
						workerEntryPath: "/worker.js",
						resources: { skillDirectories: [], promptDirectories: [] },
					},
				],
			}),
		).toThrow(/declared Pi server entry/);
		const registry = create({
			definitions: [definition],
			piContributions: [
				{
					ownerExtensionId: "owner",
					packageName: "@test/owner",
					workerEntryPath: "/worker.js",
					serverEntryPath: "/server.js",
					resources: { skillDirectories: [], promptDirectories: [] },
				},
			],
		});
		expect(registry.require("extension-provider").piContribution?.serverEntryPath).toBe(
			"/server.js",
		);
	});

	it("validates configured option defaults but permits a required per-start value to be absent", () => {
		const provider = builtinProvider("options", {
			options: defineProviderOptions({
				fields: {
					account: { label: "Account", required: true },
				},
			}),
		});
		expect(() =>
			create({
				definitions: [owned("owner", provider)],
				modelProfiles: [{ id: "profile", provider: "options", model_id: "model" }],
			}),
		).not.toThrow();
		expect(() =>
			create({
				definitions: [owned("owner", provider)],
				modelProfiles: [
					{
						id: "profile",
						provider: "options",
						model_id: "model",
						provider_options: { unknown: "value" },
					},
				],
			}),
		).toThrow(/Unknown provider option 'unknown'/);
	});
});
