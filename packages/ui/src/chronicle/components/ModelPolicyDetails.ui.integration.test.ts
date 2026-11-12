// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { mountTest } from "../../test-support/mount.js";
import { flushUi } from "../../test-support/wait.js";
import ModelPolicyDetails from "./ModelPolicyDetails.svelte";

const available = {
	id: "writing",
	label: "Writing model",
	description: "A writing model",
	availability: "available" as const,
};
const excluded = {
	...available,
	id: "coding",
	policyReason: "Requires writing label",
};

describe("model policy issue disclosure", () => {
	it.each([
		"",
		"writing",
	])("hides unrelated exclusions for healthy selection '%s'", async (selectedId) => {
		const { target } = mountTest(ModelPolicyDetails, {
			profiles: [available],
			excluded: [excluded],
			selectedId,
		});
		await flushUi();
		expect(target.querySelector("summary")).toBeNull();
	});

	it.each([
		{
			profiles: [available],
			excluded: [excluded],
			selectedId: "coding",
			reason: excluded.policyReason,
		},
		{
			profiles: [
				{ ...available, availability: "unavailable" as const, safeReason: "Credential missing" },
			],
			selectedId: "writing",
			reason: "Credential missing",
		},
		{ profiles: [], excluded: [excluded], selectedId: "", reason: excluded.policyReason },
	])("explains a selected or automatic-selection issue", async ({ reason, ...props }) => {
		const { target } = mountTest(ModelPolicyDetails, props);
		await flushUi();
		const summary = target.querySelector("summary");
		expect(summary?.textContent).toBe("Why unavailable?");
		summary?.click();
		expect(target.querySelector("details")?.open).toBe(true);
		expect(target.querySelector("details")?.textContent).toContain(reason);
	});
});
