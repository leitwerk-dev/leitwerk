import { describe, expect, it } from "vitest";
import { codingPurposes, codingSettings, commitMessageGitTimeout } from "./settings.js";

describe("commit-message Git timeout setting", () => {
	it("defaults to 60 seconds and is captured by the implementation purpose", () => {
		expect(commitMessageGitTimeout.defaultValue).toBe(60_000);
		expect(codingSettings.settings).toContain(commitMessageGitTimeout);
		expect(
			codingSettings.purposes?.find(({ id }) => id === codingPurposes.implementation)?.settingKeys,
		).toContain(commitMessageGitTimeout.key);
	});

	it("accepts positive millisecond deadlines within Node's timer range", () => {
		for (const value of [1, 120_000, 2_147_483_647])
			expect(commitMessageGitTimeout.schema.parse(value)).toBe(value);
	});

	it("rejects disabled, invalid, and overflowing deadlines", () => {
		for (const value of [0, -1, 1.5, Number.NaN, Infinity, 2_147_483_648, "60000", null])
			expect(() => commitMessageGitTimeout.schema.parse(value)).toThrow("Git timeout");
	});
});
