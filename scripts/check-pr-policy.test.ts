import { describe, expect, it } from "vitest";
import {
	commitPolicyErrorsFromLog,
	hasMatchingSignoff,
	isConventionalTitle,
} from "./check-pr-policy.mjs";

describe("pull request policy", () => {
	it.each([
		"feat: add a process",
		"fix(worker): reject stale result",
		"feat(api)!: remove legacy endpoint",
		"chore(release): release main",
		"ci(deps): update actions",
	])("accepts Conventional Commit title %s", (title) => {
		expect(isConventionalTitle(title)).toBe(true);
	});

	it.each([
		"Update dependencies",
		"feature: add a process",
		"fix: ",
		"fix(API): uppercase scope",
	])("rejects non-conventional title %s", (title) => {
		expect(isConventionalTitle(title)).toBe(false);
	});

	it("requires a sign-off matching the commit author", () => {
		expect(
			hasMatchingSignoff(
				"fix: correct race\n\nSigned-off-by: A. Developer <dev@example.com>",
				"A. Developer",
				"dev@example.com",
			),
		).toBe(true);
		expect(
			hasMatchingSignoff(
				"fix: correct race\n\nSigned-off-by: Someone Else <other@example.com>",
				"A. Developer",
				"dev@example.com",
			),
		).toBe(false);
	});

	it("accepts a signed commit whose message has no trailing newline", () => {
		const log = [
			"313b84847129ff50b5b548ec34077fe1b112a6e8",
			"github-actions[bot]",
			"41898282+github-actions[bot]@users.noreply.github.com",
			"chore(release): release main\n\nSigned-off-by: github-actions[bot] <41898282+github-actions[bot]@users.noreply.github.com>",
		].join("\x00");

		expect(commitPolicyErrorsFromLog(`${log}\x1e`)).toEqual([]);
	});
});
