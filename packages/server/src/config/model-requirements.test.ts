import { describe, expect, it } from "vitest";
import { getDefaultConfig, validateConfig } from "./config-loader.js";

function config() {
	const value = getDefaultConfig();
	value.pi.default_model_profile = "general";
	value.pi.model_profiles = [
		{
			id: "general",
			provider: "test",
			model_id: "one",
			labels: ["coding", "free", "premium", "coding"],
			default: true,
		},
	];
	return value;
}

describe("model policy configuration", () => {
	it("accepts missing and multiple cost labels without deriving pricing labels", () => {
		for (const labels of [[], ["coding", "free", "premium", "coding"]]) {
			const value = config();
			value.pi.model_profiles[0].labels = labels;
			expect(validateConfig(value)).toEqual([]);
		}
	});
	it.each([
		{ profiles: [] },
		{ profiles: [""] },
		{ profiles: [" general "] },
		{ labels: { any_of: [] } },
		{ labels: { all_of: ["Coding"] } },
		{ capabilities: ["image input"] },
		{ cost_tiers: ["free"] },
	])("rejects malformed restrictions %j", (requirements) => {
		const value = config();
		value.process_configs = {
			policy: { model_requirements: requirements, turn_configs: {} },
		} as never;
		expect(validateConfig(value).join("\n")).toContain("model_requirements");
	});
	it("accepts an individually valid but contradictory policy for dashboard diagnosis", () => {
		const value = config();
		value.process_configs = {
			policy: {
				model_requirements: { labels: { all_of: ["coding"], none_of: ["coding"] } },
				turn_configs: { run: { model_requirements: { profiles: ["general"] } } },
			},
		};
		expect(validateConfig(value)).toEqual([]);
	});
});
