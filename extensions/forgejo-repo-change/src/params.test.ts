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
	it("normalizes legacy issue launches to an issue origin", () => {
		const parsed = forgejoRepoChangeParamsCodec.parse({
			...common,
			issueNumber: 42,
			issueUrl: "https://git.example.test/team/service/issues/42",
			triggerLabel: "use-leitwerk",
			doneLabel: "leitwerk-done",
		});
		expect(parsed).toMatchObject({ origin: "issue", issueNumber: 42 });
		expect(isIssueOrigin(parsed)).toBe(true);
		for (const field of ["forgejoProfile", "doneLabel"])
			expect(() => forgejoRepoChangeParamsCodec.parse({ ...parsed, [field]: " " })).toThrow(
				`Forgejo Repo Change requires ${field}`,
			);
	});

	it("parses a UI launch without issue metadata", () => {
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
