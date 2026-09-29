import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { assertSandboxPath } from "@leitwerk-dev/dev-sandbox/storage";
import type { GitLabProject } from "@leitwerk-dev/gitlab";
import type { AppContext } from "@leitwerk-dev/server";
import type { LocalGit } from "@leitwerk-dev/test-support/local-git";
import { StubPiTreeHandleFactory } from "@leitwerk-dev/test-support/worker-testing";

/** Script the real turn contracts; publication remains owned by the workflow. */
export function jiraGitLabScripts(
	git: LocalGit,
	context: () => AppContext,
	repositories: readonly GitLabProject[],
) {
	return new StubPiTreeHandleFactory({
		recordSessionTrace: true,
		toolCallScriptResolver(input) {
			const process = input.instanceId ? context().deps.processes.getById(input.instanceId) : null;
			if (!process || !input.workspaceRoot) throw new Error("Missing scripted workspace");
			const projects = context().deps.projects.listByInstance(process.id);
			const turn = process.selectedTurnId;
			const result = (toolName: string, args: Record<string, unknown>) => ({
				thinkingChunks: [
					`Scripted example: ${turn}. Keep the delivery wording consistent across the selected repositories and record a separate result for each checkout.`,
				],
				calls: [{ toolName, args }],
			});
			const markdown = (markdown: string) => result("markdown_result", { markdown });
			const names = projects.map((project) => {
				const repository = repositories.find(
					(repo) => repo.ssh_url_to_repo === project.repoLocator,
				);
				if (!repository) throw new Error("Unknown sandbox repository");
				return `**${project.key} · ${repository.path_with_namespace}**`;
			});
			if (turn === "generate_plan")
				return result("plan_saved", {
					summary: "Use consistent delivery-window wording across Atlas",
					markdown: [
						"## Consistent delivery windows",
						"Customers should see the same date range in the delivery API and checkout.",
						...names.map(
							(name) =>
								`${name}\n\nUpdate the repository overview, delivery contract, and customer-facing wording. Preserve existing date and time-zone behavior.`,
						),
						"### Validation\n\nCheck staged, unstaged, and new files; run whitespace checks in every checkout. After approval, simplify the changes and publish a merge request for each changed repository.",
					].join("\n\n"),
					acceptanceCriteria: [
						"API and checkout use the same delivery-window wording",
						"Date and time-zone behavior stays unchanged",
						"Each changed repository has a separate merge request",
					],
				});
			if (turn === "simplify_implementation")
				return markdown(
					names
						.map(
							(name) =>
								`${name}\n\nThe staged README and unstaged delivery notes introduce the contract; keep them. The new customer-copy.md repeats the same date-range instruction twice. Replace those two sentences with one. No behavior change is needed.`,
						)
						.join("\n\n"),
				);
			if (turn === "generate_commit_message") {
				const messages = Object.fromEntries(
					projects.map((project) => [project.key, "docs: clarify delivery-window wording"]),
				);
				return markdown(
					process.processId === "jira_gitlab_change_process"
						? JSON.stringify(messages)
						: "docs: clarify delivery-window wording",
				);
			}
			if (turn === "implement" || turn === "apply_simplification") {
				for (const project of projects) {
					const directory = path.join(input.workspaceRoot, project.key);
					const write = (file: string, content: string) => {
						const target = path.join(directory, file);
						assertSandboxPath(git.root, target);
						writeFileSync(target, content);
					};
					if (turn === "implement") {
						write(
							"README.md",
							`${readFileSync(path.join(directory, "README.md"), "utf8")}\nDelivery windows use a shared date-range contract.\n`,
						);
						git.run(directory, ["add", "README.md"]);
						write(
							"delivery-notes.md",
							"# Delivery contract\n\nKeep dates in the customer's time zone. Use the same range in the API and checkout.\n",
						);
						write(
							"customer-copy.md",
							"# Customer wording\n\nDisplay the expected delivery date range.\nShow the date range for expected delivery.\n",
						);
					} else {
						write(
							"customer-copy.md",
							"# Customer wording\n\nShow the expected delivery date range.\n",
						);
					}
					git.run(directory, ["diff", "--check"]);
					git.run(directory, ["diff", "--cached", "--check"]);
				}
				return turn === "implement"
					? result("implementation_ready", {
							markdown: `${names.join("\n\n")}\n\nUpdated the delivery contract and wording. Staged README changes, unstaged notes, and a new customer-copy file are ready for simplification. Whitespace checks passed in every repository.`,
						})
					: markdown(
							"Applied the saved findings in every repository: combined the duplicated customer-copy sentences and retained the delivery contract. Re-ran staged and unstaged whitespace checks; all passed. Changes remain uncommitted for delivery.",
						);
			}
			if (input.tools.some((tool) => tool.name === "cannot_repair"))
				return result("cannot_repair", {
					markdown:
						"This scripted review scene has no repair recipe. Use the sandbox controls to supply a passing pipeline or inspect the operator actions.",
				});
			throw new Error(`No scripted Jira/GitLab behavior for ${turn}`);
		},
	});
}
