import {
	builtinPiProvider,
	defineModelProvider,
	defineProviderOptions,
} from "@leitwerk-dev/process-sdk";
import { describe, expect, it } from "vitest";
import { ownedProviderSet } from "../test-helpers/model-provider-fixtures.js";
import { loadProviderOptionChoices, resolveRegisteredProviderOptions } from "./provider-options.js";
import { createModelProviderRegistry } from "./registry.js";

function providerFixture() {
	const definition = defineModelProvider({
		id: "provider",
		parseConfig: () => ({ config: { defaultAccount: "provider-default" } }),
		worker: builtinPiProvider("provider"),
		models: () => [],
		options: defineProviderOptions<{ defaultAccount: string }>({
			fields: {
				account: {
					label: "Account",
					required: true,
					defaultValue: ({ config }) => config.defaultAccount,
				},
			},
			choices: () => ({ account: [{ value: "listed", label: "Listed account" }] }),
		}),
		secrets: () => ({}),
	});
	return createModelProviderRegistry({
		sets: [ownedProviderSet(definition)],
		piContributions: [],
		extensionConfig: { owner: {} },
		modelProfiles: [],
		titleModelProfileId: null,
	}).require("provider");
}

describe("provider option server wrappers", () => {
	it("resolves explicit, profile, and provider defaults without consulting choices", () => {
		const provider = providerFixture();
		expect(
			resolveRegisteredProviderOptions({
				provider,
				explicit: { account: "not-in-dynamic-choices" },
				profileDefaults: { account: "profile-default" },
			}),
		).toEqual({ ok: true, value: { account: "not-in-dynamic-choices" } });
		expect(resolveRegisteredProviderOptions({ provider })).toEqual({
			ok: true,
			value: { account: "provider-default" },
		});
	});

	it("returns advisory choices separately from structural validation", async () => {
		const provider = providerFixture();
		const result = await loadProviderOptionChoices({
			provider,
			credentialStatus: () => ({ available: false, revision: null }),
		});
		expect(result).toEqual({
			ok: true,
			choices: { account: [{ value: "listed", label: "Listed account" }] },
		});
		expect(
			resolveRegisteredProviderOptions({
				provider,
				explicit: { account: "still-valid-when-unlisted" },
			}),
		).toEqual({ ok: true, value: { account: "still-valid-when-unlisted" } });
	});
});
