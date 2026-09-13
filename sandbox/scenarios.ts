import { writeFileSync } from "node:fs";
import path from "node:path";
import type { SandboxScenario } from "@leitwerk-dev/dev-sandbox";
import { assertSandboxPath } from "@leitwerk-dev/dev-sandbox/storage";
import type { LocalRepoChangeParams } from "@leitwerk-dev/local-repo-change";
import type { AppContext } from "@leitwerk-dev/server";
import {
	StubPiTreeHandleFactory,
	type StubToolCallScriptCall,
	type StubToolCallScriptResolver,
} from "@leitwerk-dev/test-support/worker-testing";
import type { Notebook } from "./notebook.js";

export const scenarioDescriptions = {
	"repository-change": "Plan, implement, commit and merge a notebook change.",
	ticket: "Create a ticket from a durable plan result, then approve its draft.",
	question: "Answer a notebook question before reviewing the plan.",
	"long-message": "Inspect a long Markdown plan and its recorded reasoning.",
	streaming: "Watch the model stream its observations before saving a plan.",
	failure: "Retry a failed planning turn through the ordinary process UI.",
	"turn-rail": "Run and accept three plan reviews; answer a question on planning pass four.",
	startup: "Inspect seven seconds of connection delay followed by worker preparation.",
	"startup-cold": "Inspect a slower cold start, or cancel before the worker connects.",
};
export function notebookScenarios(notebook: Notebook): SandboxScenario<LocalRepoChangeParams>[] {
	return Object.entries(scenarioDescriptions).map(([name, description]) => ({
		name,
		description,
		...(name === "startup"
			? { startupDelays: { connectMs: 7000, prepareMs: 1000 } }
			: name === "startup-cold"
				? { startupDelays: { connectMs: 10800, prepareMs: 1000 } }
				: {}),
		launch: (_input, workBranch) => ({
			processId: "local_repo_change_process",
			params: {
				launchKind: "requested_change",
				repoLocator: notebook.repository,
				baseBranch: "main",
				workBranch,
				prompt: "Document the weekly garden review in notes.txt.",
			},
			projects: [{ key: "repo", repoLocator: notebook.repository, baseBranch: "main", workBranch }],
		}),
	}));
}

export function notebookScripts(notebook: Notebook, context: () => AppContext) {
	const resolve: StubToolCallScriptResolver = (input) => {
		const process = input.instanceId ? context().deps.processes.getById(input.instanceId) : null;
		if (!process) throw new Error("Unknown scripted process");
		notebook.state.scenarios[process.id] ??= {
			name: process.externalId?.split(":")[1] ?? "ticket",
			step: 0,
		};
		const progress = notebook.state.scenarios[process.id];
		progress.step++;
		notebook.save();
		const names = new Set(input.tools.map((t) => t.name));
		const call = (toolName: string, args: Record<string, unknown>) => ({ toolName, args });
		const markdown = (markdown: string) => call("markdown_result", { markdown });
		const question = (id: string, question: string) =>
			call("ask_questions", {
				questions: [
					{
						id,
						question,
						selection: "single",
						options: [
							{ label: "Garden (Recommended)", details: "Keep planting notes together." },
							{ label: "Workshop", details: "Use the workshop notebook." },
						],
					},
				],
			});
		if (names.has("local_create_ticket")) {
			const params = JSON.parse(process.paramsJson ?? "{}");
			const ticket = call("local_create_ticket", {
				title: `Improve the garden notebook${progress.step > 1 ? ` (revision ${progress.step})` : ""}`,
				body: "Document the weekly planting review.",
				destinationId: "garden",
			});
			const afterToolResult = (
				call: StubToolCallScriptCall,
				result: unknown,
			): StubToolCallScriptCall | undefined => {
				if (
					call.toolName === "local_create_ticket" &&
					result &&
					typeof result === "object" &&
					"code" in result &&
					result.code === "operator_feedback"
				)
					return {
						...call,
						args: {
							...call.args,
							title: `Revised: ${call.args.title}`,
							body: `Document the weekly planting review.\n\n${"feedback" in result ? result.feedback : ""}`,
						},
					};
				return undefined;
			};
			if (progress.step === 1 && /clarify/i.test(params.context?.additionalInstructions ?? ""))
				return {
					calls: [
						question("ticket-destination", "Which notebook should receive this ticket?"),
						ticket,
					],
					afterToolResult,
				};
			return { calls: [ticket], afterToolResult };
		}
		if (progress.name === "failure" && progress.step === 1)
			throw new Error("Scripted turn failure. Retry from the ordinary process UI.");
		if (names.has("plan_saved")) {
			const plan = call("plan_saved", {
				markdown:
					progress.name === "long-message"
						? `# Garden notebook\n\n${"A detailed observation for the next planting season.\n\n".repeat(400)}`
						: "## Plan\n\nUpdate notes.txt with the weekly garden review. Verify, commit and merge the change.",
				summary: "Document the weekly review",
				acceptanceCriteria: ["notes.txt documents the weekly review"],
			});
			if (
				(progress.name === "question" && process.planRevision === 0) ||
				(progress.name === "turn-rail" && process.planRevision === 3)
			)
				return { calls: [question("notebook", "Which notebook should we update?"), plan] };
			if (["streaming", "startup", "startup-cold"].includes(progress.name))
				return {
					textChunks: Array.from(
						{ length: 80 },
						(_, i) => `Observation ${i + 1}: planning the weekly garden review.\n`,
					),
					chunkDelayMs: 200,
					calls: [plan],
				};
			return plan;
		}
		if (names.has("request_changes"))
			return call("request_changes", {
				markdown: "Clarify the watering schedule in the next plan revision.",
			});
		if (process.selectedTurnId === "implement") {
			if (!input.workspaceRoot) throw new Error("Scripted workspace is missing");
			const directory = path.join(input.workspaceRoot, "repo");
			notebook.git(directory, ["config", "user.name", "Sandbox Developer"]);
			notebook.git(directory, ["config", "user.email", "developer@sandbox.invalid"]);
			assertSandboxPath(notebook.directory, path.join(directory, "notes.txt"));
			writeFileSync(
				path.join(directory, "notes.txt"),
				`Weekly review: record planting dates and watering observations.\nRevision ${progress.step}\n`,
			);
			return markdown("Updated notes.txt with the weekly review.");
		}
		return markdown("docs: document weekly garden review");
	};
	return new StubPiTreeHandleFactory({
		recordSessionTrace: true,
		async toolCallScriptResolver(input) {
			const script = await resolve(input);
			if (!script) return script;
			const response = "calls" in script ? script : { calls: [script] };
			return {
				...response,
				thinkingChunks: [
					"**Preparing the notebook change**\n\nUse the selected turn and its available tools to record the result. The operator reviews each plan and implementation before finalization.\n\n",
				],
			};
		},
	});
}
