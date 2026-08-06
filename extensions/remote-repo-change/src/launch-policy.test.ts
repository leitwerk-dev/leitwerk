import { describe, expect, it } from "vitest";
import { remoteRepoChangeLaunchPlanner } from "./launch-policy.js";
import { remoteRepoChangeProcess } from "./process-definition.js";

const validInput = {
	launchKind: "requested_change",
	repoLocator: "git@git.example.com:team/repo.git",
	baseBranch: "main",
	workBranch: "",
	prompt: "Improve repository credential handling",
	sshCredentialRef: "default",
};

describe("remote repo change launch policy", () => {
	it("derives a branch and makes every valid launch immediately actionable", () => {
		const result = remoteRepoChangeLaunchPlanner.plan({ input: validInput });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		const workBranch = result.launchConfig.params.workBranch;
		expect(workBranch).toMatch(/^improve-repository-credential-handling-[0-9a-f]{3}-[0-9a-f]{12}$/);
		expect(result.launchConfig.projects[0]?.workBranch).toBe(workBranch);
		expect(result.launchConfig.startTurnId).toBe("generate_plan");
	});

	it("requires an SSH locator and credential reference", () => {
		const result = remoteRepoChangeLaunchPlanner.plan({
			input: {
				...validInput,
				repoLocator: "https://git.example.com/team/repo",
				sshCredentialRef: "",
			},
		});
		expect(result).toMatchObject({
			ok: false,
			errors: expect.arrayContaining([
				expect.objectContaining({ fieldId: "repoLocator" }),
				expect.objectContaining({ fieldId: "sshCredentialRef" }),
			]),
		});
	});

	it("declares its credential requirement through the built process", () => {
		expect(
			remoteRepoChangeProcess.repositoryCredentials?.({
				params: { ...validInput, workBranch: "feature/change" },
				projects: [],
			}),
		).toEqual([{ projectKey: "repo", kind: "git_ssh", credentialRef: "default" }]);
	});
});
