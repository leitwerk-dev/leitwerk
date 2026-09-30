import path from "node:path";
import type { ProcessProject } from "@leitwerk-dev/domain";
import type { PiCustomTool } from "@leitwerk-dev/process-sdk";
import { planRunRoot, prepareOnDemandRunRoot, type RunRootGitOps } from "./run-root.js";

/** @internal */
export function createCheckoutTool(
	workspaceRoot: string,
	instanceId: string,
	projects: readonly ProcessProject[],
	git: RunRootGitOps,
): PiCustomTool {
	return {
		name: "checkout_repository",
		description:
			"Materialize a full clone for one authorized project and return its checked-out revision. Repeated calls reuse the checkout. Inspect only; do not publish changes.",
		parameters: {
			type: "object",
			properties: { projectKey: { type: "string" } },
			required: ["projectKey"],
			additionalProperties: false,
		},
		executionMode: "sequential",
		async execute(args) {
			if (typeof args.projectKey !== "string") throw new Error("projectKey is required");
			const plan = planRunRoot(
				workspaceRoot,
				instanceId,
				projects.map((project) => ({
					key: project.key,
					repoLocator: project.repoLocator,
					baseBranch: project.baseBranch,
					workBranch: project.workBranch || project.baseBranch,
				})),
			);
			const result = await prepareOnDemandRunRoot(plan, git, args.projectKey);
			const entry = result.manifest.components.find(
				(component) => component.key === args.projectKey,
			);
			if (!entry) throw new Error("Checkout did not produce repository evidence");
			const repositoryPath = path.join(workspaceRoot, entry.key);
			return {
				...entry,
				headSha: await git.getHeadSha(repositoryPath),
				path: repositoryPath,
				instructions:
					"Read this repository's AGENTS.md before inspection; revalidate any wiki guidance against this revision. This checkout is retained, not automatically updated to the remote head.",
			};
		},
	};
}
