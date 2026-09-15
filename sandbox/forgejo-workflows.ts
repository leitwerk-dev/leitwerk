import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { SandboxScenario } from "@leitwerk-dev/dev-sandbox";
import type { LocalForgejoAdapter } from "@leitwerk-dev/forgejo/testing";
import type { ForgejoRepoChangeParams } from "@leitwerk-dev/forgejo-repo-change";
import type { GitSshIntegration } from "@leitwerk-dev/git-ssh";
import type { AppContext } from "@leitwerk-dev/server";
import { localPath } from "@leitwerk-dev/test-support/local-git";
import type { StubToolCallScriptResolver } from "@leitwerk-dev/test-support/worker-testing";

export const forgejoScenarioDescriptions = {
	"forgejo-change":
		"Approve a plan and implementation, then publish a real branch and pull request.",
	"forgejo-feedback-no-change":
		"Receive review feedback and reply without changing the repository.",
	"forgejo-feedback-operator":
		"Route review feedback to an operator when the script cannot repair it.",
	"forgejo-ci-restart":
		"Diagnose a failed pipeline, explicitly restart it, and wait for the result.",
	"forgejo-ci-operator": "Route a failed pipeline to operator recovery.",
};

export function forgejoScenarios(
	forgejo: LocalForgejoAdapter,
	repository: string,
): SandboxScenario<ForgejoRepoChangeParams>[] {
	return Object.entries(forgejoScenarioDescriptions).map(([name, description]) => ({
		name,
		description,
		launch: (_input, workBranch) => {
			const r = forgejo.state.repositories.find(
				(r) => r.repository.full_name === repository,
			)?.repository;
			if (!r) throw new Error("Missing seeded workflow repository");
			const binding = { owner: r.owner.login, repo: r.name, profile: "local" };
			return {
				processId: "forgejo_repo_change_process",
				params: {
					launchKind: "requested_change",
					repoLocator: r.ssh_url,
					baseBranch: r.default_branch,
					workBranch,
					prompt: "Document the weekly garden review in notes.txt.",
					forgejoProfile: "local",
					woodpeckerProfile: "local",
					sshCredentialRef: "local",
					owner: r.owner.login,
					repo: r.name,
					origin: "ui",
					issueNumber: null,
					issueUrl: null,
					triggerLabel: null,
					doneLabel: null,
				},
				projects: [
					{
						key: "repo",
						repoLocator: r.ssh_url,
						baseBranch: r.default_branch,
						workBranch,
						metadata: {
							forgejo: binding,
							woodpecker: binding,
							"leitwerk.gitIdentity": {
								provider: "forgejo",
								profile: "local",
								login: "leitwerk-bot",
								name: "Sandbox Developer",
								email: "developer@sandbox.invalid",
							},
						},
					},
				],
			};
		},
	}));
}

/** File remotes are accepted only when they name one of this composition's seeds. */
export function localGitSsh(forgejo: LocalForgejoAdapter): GitSshIntegration {
	return {
		profiles: () => ["local"],
		async preflight(input) {
			const r = forgejo.state.repositories.find((r) => r.repository.ssh_url === input.repoLocator);
			if (input.credentialRef !== "local" || !r || input.baseBranch !== r.repository.default_branch)
				return { ok: false, access: "read", detail: "Repository is not a configured local seed" };
			try {
				const sha = forgejo.git
					.run(input.repoLocator, [
						"ls-remote",
						"--exit-code",
						input.repoLocator,
						`refs/heads/${input.baseBranch}`,
					])
					.split(/\s+/)[0];
				if (input.requireWrite)
					forgejo.git.run(input.repoLocator, [
						"push",
						"--dry-run",
						input.repoLocator,
						`${sha}:refs/heads/leitwerk-preflight`,
					]);
				return { ok: true };
			} catch {
				return {
					ok: false,
					access: input.requireWrite ? "write" : "read",
					detail: "Local Git access check failed",
				};
			}
		},
	};
}

/** Scripts use selected turns, persisted evidence and tool contracts. */
export function forgejoScripts(
	forgejo: LocalForgejoAdapter,
	context: () => AppContext,
	fallback: StubToolCallScriptResolver,
): StubToolCallScriptResolver {
	return async (input) => {
		const process = input.instanceId ? context().deps.processes.getById(input.instanceId) : null;
		if (process?.processId !== "forgejo_repo_change_process") return fallback(input);
		const state = JSON.parse(process.stateJson ?? "{}");
		const remote = state.extensionState?.forgejoRepoChange ?? {};
		const names = new Set(input.tools.map((t) => t.name));
		const scene = process.externalId?.split(":")[1] ?? "forgejo-change";
		const call = (toolName: string, args: Record<string, unknown>) => ({ toolName, args });
		const response = (...calls: Array<ReturnType<typeof call>>) => ({
			calls,
			thinkingChunks: [
				"Use the current turn and recorded provider evidence. Keep the plan and implementation available for operator approval.\n",
			],
		});
		const markdown = (markdown: string) => call("markdown_result", { markdown });
		if (names.has("plan_saved"))
			return response(
				call("plan_saved", {
					markdown:
						"## Plan\n\nDocument the weekly garden review in notes.txt. Publish the approved change for review.",
					summary: "Document the garden review",
					acceptanceCriteria: ["The notes include the weekly review"],
				}),
			);
		if (names.has("request_changes"))
			return response(call("request_changes", { markdown: "Clarify the watering schedule." }));
		if (process.selectedTurnId === "implement" || names.has("changes_ready")) {
			if (!input.workspaceRoot) throw new Error("Missing workflow workspace");
			const directory = localPath(
				forgejo.options.root,
				path.relative(forgejo.options.root, path.join(input.workspaceRoot, "repo")),
			);
			const git = (...args: string[]) => forgejo.git.run(directory, args);
			const write = (file: string, content: string) =>
				writeFileSync(localPath(directory, file), content);
			if (remote.repairReason === "rebase") {
				const record = JSON.parse(
					readFileSync(localPath(directory, ".git/leitwerk-rebase.json"), "utf8"),
				);
				if (
					record.originalHead !== remote.conflict?.headSha ||
					record.branch !== remote.conflict?.headBranch
				)
					throw new Error("Mismatched retained rebase record");
				while (
					existsSync(path.join(directory, ".git/rebase-merge")) ||
					existsSync(path.join(directory, ".git/rebase-apply"))
				) {
					const conflicts = git("diff", "--name-only", "--diff-filter=U")
						.split("\n")
						.filter(Boolean);
					for (const file of conflicts) {
						// Preserve both seeded notebook edits, then continue Git's active rebase.
						if (file !== "notes.txt") throw new Error("Unexpected conflict outside notebook notes");
						write(
							file,
							"Weekly review: record planting dates and watering observations.\nBase update: preserve seasonal notes.\n",
						);
						git("add", "--", file);
					}
					git("-c", "core.editor=true", "rebase", "--continue");
				}
				return response(
					call("changes_ready", {
						markdown: "Resolved the notebook conflict and continued the retained rebase.",
					}),
				);
			}
			if (
				names.has("changes_ready") &&
				(scene === "forgejo-feedback-operator" || scene === "forgejo-ci-operator")
			)
				return response(
					call("cannot_repair", {
						markdown: "Operator judgment is required to resolve this evidence.",
					}),
				);
			if (names.has("changes_ready") && scene === "forgejo-feedback-no-change")
				return response(
					call("no_changes", { markdown: "The current notes already cover the requested review." }),
				);
			if (process.selectedTurnId === "repair_woodpecker_pipeline") {
				const pipeline = remote.pipeline;
				if (!pipeline) throw new Error("Missing CI evidence");
				const reads = [
					call("woodpecker_get_pipeline", { projectKey: "repo", pipelineNumber: pipeline.number }),
					call("woodpecker_get_step_logs", {
						projectKey: "repo",
						pipelineNumber: pipeline.number,
						stepId: 1,
						tailLines: 100,
						maxBytes: 16384,
					}),
				];
				if (scene === "forgejo-ci-restart")
					return response(
						...reads,
						call("woodpecker_restart_pipeline", {
							projectKey: "repo",
							pipelineNumber: pipeline.number,
							diagnosis: "The sandbox restart scene simulates a transient runner failure.",
							logEvidence: "The selected pipeline log was inspected; retry the simulated runner.",
						}),
						call("no_changes", {
							markdown: "Restarted the current pipeline after inspecting its logs.",
						}),
					);
				write("check.txt", "pass\n");
				write(
					"notes.txt",
					`Weekly review: record planting dates and watering observations.\nCI repair ${remote.ciRecoveryCycles}.\n`,
				);
				return response(
					...reads,
					call("changes_ready", { markdown: "Fixed check.txt after inspecting the failed check." }),
				);
			}
			write(
				"notes.txt",
				`Weekly review: record planting dates and watering observations.\nFeedback revision ${remote.conversationCursor ?? 0}/${remote.reviewCursor ?? 0}/${remote.inlineCursor ?? 0}.\n`,
			);
			if (names.has("changes_ready"))
				return response(
					call("forgejo_list_pull_request_feedback", {
						projectKey: "repo",
						pullRequestNumber: remote.prNumber,
					}),
					call("changes_ready", { markdown: "Added the requested watering notes." }),
				);
			return response(markdown("Updated notes.txt with the weekly review."));
		}
		return response(markdown("docs: document weekly garden review"));
	};
}
