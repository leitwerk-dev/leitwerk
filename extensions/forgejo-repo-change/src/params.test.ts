import { describe, expect, it } from "vitest";
import { forgejoRepoChangeParamsCodec, isIssueOrigin } from "./params.js";

const common = {
	repoLocator: "ssh://git@git.example.test/team/service.git",
	baseBranch: "main",
	workBranch: "leitwerk/issue-42",
	prompt: "Change it",
	forgejoProfile: "team",
	woodpeckerProfile: "team",
	sshCredentialRef: "team",
	owner: "team",
	repo: "service",
};

describe("Forgejo repository-change params", () => {
	it.each([undefined, "", " issue "])("normalizes issue origin %j", (origin) => {
		const parsed = forgejoRepoChangeParamsCodec.parse({
			...common,
			origin,
			issueNumber: 42,
			issueUrl: "https://git.example.test/team/service/issues/42",
			triggerLabel: "use-leitwerk",
			doneLabel: "leitwerk-done",
		});
		expect(parsed).toMatchObject({ origin: "issue", issueNumber: 42 });
		expect(isIssueOrigin(parsed)).toBe(true);
		expect(
			forgejoRepoChangeParamsCodec.parse({ ...parsed, issueNumber: 2 ** 53 }).issueNumber,
		).toBe(2 ** 53);
		for (const issueNumber of [0, -1, 1.5, "42"])
			expect(() => forgejoRepoChangeParamsCodec.parse({ ...parsed, issueNumber })).toThrow(
				"requires issueNumber",
			);
		expect(() => forgejoRepoChangeParamsCodec.parse({ ...parsed, origin: "other" })).toThrow(
			"requires a valid origin",
		);
		for (const field of ["forgejoProfile", "doneLabel"])
			expect(() => forgejoRepoChangeParamsCodec.parse({ ...parsed, [field]: " " })).toThrow(
				`Forgejo Repo Change requires ${field}`,
			);
	});

	it("round-trips a UI launch without issue metadata", () => {
		const parsed = forgejoRepoChangeParamsCodec.parse({
			...common,
			origin: "ui",
			workBranch: "improve-status-abc-123456789012",
			issueNumber: null,
			issueUrl: null,
			triggerLabel: null,
			doneLabel: null,
		});
		expect(parsed).toMatchObject({
			origin: "ui",
			issueNumber: null,
			issueUrl: null,
			triggerLabel: null,
			doneLabel: null,
		});
		expect(isIssueOrigin(parsed)).toBe(false);
	});
});
