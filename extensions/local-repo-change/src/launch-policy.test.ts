import { describe, expect, it } from "vitest";
import { localRepoChangeLaunchPlanner } from "./launch-policy.js";

const shared = {
	repoLocator: " ./repo ",
	baseBranch: " main ",
	prompt: " Implement the change ",
};

describe("localRepoChangeLaunchPlanner", () => {
	it.each([
		{
			launchKind: "requested_change",
			workBranch: "feature/demo",
			expectedTurn: "generate_plan",
		},
		{ launchKind: "requested_change", workBranch: "", expectedTurn: null },
		{
			launchKind: "imported_plan",
			workBranch: "feature/demo",
			importedPlanMarkdown: "# Plan",
			expectedTurn: "import_plan",
		},
		{
			launchKind: "imported_plan",
			workBranch: "",
			importedPlanMarkdown: "# Plan",
			expectedTurn: null,
		},
	] as const)("plans $launchKind with workBranch '$workBranch'", (input) => {
		const result = localRepoChangeLaunchPlanner.plan({
			input: { ...shared, ...input },
			metadata: { source: "test" },
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.launchConfig).toMatchObject({
			processId: "local_repo_change_process",
			startTurnId: input.expectedTurn,
			params: {
				launchKind: input.launchKind,
				repoLocator: "./repo",
				baseBranch: "main",
				workBranch: input.workBranch,
				prompt: "Implement the change",
			},
			metadata: { source: "test" },
			titleSourceFields: [{ label: "Requested change", value: "Implement the change" }],
			projects: [
				{
					key: "repo",
					repoLocator: "./repo",
					baseBranch: "main",
					workBranch: input.workBranch || null,
				},
			],
		});
	});

	it.each([
		[
			{ ...shared, workBranch: "" },
			{ fieldId: "launchKind", message: "launchKind must be requested_change or imported_plan" },
		],
		[
			{ ...shared, launchKind: "other", workBranch: "" },
			{ fieldId: "launchKind", message: "launchKind must be requested_change or imported_plan" },
		],
		[
			{ ...shared, launchKind: "imported_plan", workBranch: "" },
			{
				fieldId: "importedPlanMarkdown",
				message: "importedPlanMarkdown is required for imported_plan launches",
			},
		],
		[
			{
				...shared,
				launchKind: "requested_change",
				workBranch: "",
				importedPlanMarkdown: "# Unexpected",
			},
			{
				fieldId: "importedPlanMarkdown",
				message: "importedPlanMarkdown is not allowed for requested_change launches",
			},
		],
		[
			{ ...shared, launchKind: "requested_change", repoLocator: " ", workBranch: "" },
			{
				fieldId: "repoLocator",
				message: "repoLocator must be a local filesystem path or remote git URL",
			},
		],
		[
			{ ...shared, launchKind: "requested_change", workBranch: "main" },
			{ fieldId: "workBranch", message: "workBranch cannot match baseBranch" },
		],
		[
			{ ...shared, launchKind: "requested_change", workBranch: "", prompt: "" },
			{ fieldId: "prompt", message: "prompt is required" },
		],
	] as const)("returns typed validation errors", (input, expectedError) => {
		const result = localRepoChangeLaunchPlanner.plan({ input });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.errors).toContainEqual(expect.objectContaining(expectedError));
	});
});
