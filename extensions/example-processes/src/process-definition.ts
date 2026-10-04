import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AutomaticOutcomeBuilder,
	type Codec,
	createEmptyStructuralProcessState,
	type ExtensionProcessDefinition,
	flow,
	type HumanFlowBuilder,
	type StructuralProcessState,
	structuralStateCodec,
} from "@leitwerk-dev/process-sdk";
import { fileExternal } from "./file-external.js";
import {
	externalPromptCompletionTurnDescription,
	externalPromptCompletionTurnId,
} from "./turns/external-complete.js";
import {
	buildSinglePromptInstruction,
	buildSinglePromptWithToolInstruction,
} from "./turns/run-single-prompt.js";

/** @internal */
interface PromptProcessParams {
	/** @internal */
	prompt: string;
}

const promptProcessParamsCodec: Codec<PromptProcessParams> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			prompt:
				typeof (record as { prompt?: unknown }).prompt === "string"
					? (record as { prompt: string }).prompt
					: "",
		};
	},
	serialize(value) {
		return value;
	},
};

function validateLaunchInput(input: Record<string, unknown>, fallbackPrompt?: string) {
	const inputPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
	const prompt = inputPrompt || fallbackPrompt?.trim() || "";
	if (!prompt) {
		return {
			ok: false as const,
			errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
		};
	}
	return {
		ok: true as const,
		prompt,
	};
}

function buildPromptTitleSourceFields(prompt: string, label = "Prompt") {
	return [{ label, value: prompt }] as const;
}

function promptLaunchResolution(options: {
	processId: string;
	startTurnId: string;
	defaultPrompt?: () => string;
	titleLabel?: string;
}) {
	return {
		resolveDefaults: () => ({ prompt: options.defaultPrompt?.() ?? "" }),
		resolveLaunchConfig(input: Record<string, unknown>) {
			const validated = validateLaunchInput(input, options.defaultPrompt?.());
			if (!validated.ok) return validated;
			return {
				ok: true as const,
				launchConfig: {
					processId: options.processId,
					params: { prompt: validated.prompt },
					titleSourceFields: buildPromptTitleSourceFields(validated.prompt, options.titleLabel),
					startTurnId: options.startTurnId,
				},
			};
		},
	};
}

function createMarkdownLeafOutcome(rendererId: string) {
	return {
		rendererId,
		capture(ctx: {
			params: PromptProcessParams;
			leaf: { entryId: string; turnRecordId: string | null };
			turnRecord: { turnResultMarkdown: string | null } | null;
		}) {
			const markdown = ctx.turnRecord?.turnResultMarkdown?.trim() ?? "";
			return {
				rendererId,
				schemaVersion: 1,
				props: {
					prompt: ctx.params.prompt,
					markdown: markdown.length > 0 ? markdown : null,
					leafEntryId: ctx.leaf.entryId,
					turnRecordId: ctx.leaf.turnRecordId,
				},
				fallbackMarkdown: markdown.length > 0 ? markdown : null,
			};
		},
	};
}

/** @internal */
export const singlePromptProcess: ExtensionProcessDefinition<
	PromptProcessParams,
	StructuralProcessState
> = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_process")
	.displayName("Single Prompt")
	.entry("run_single_prompt")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt")
			.description("Run Prompt")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptInstruction(ctx.params.prompt))
			.end("completed")
			.complete(),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_process.single_prompt_ui",
		label: "Single Prompt",
		description: "Run one prompt and finish on turn end",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt",
				description:
					"Run a one-shot prompt. The shared launcher shell chooses the model configuration.",
			},
			launchConfigSchema: {
				id: "single_prompt_form",
				title: "Single Prompt",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello.",
						description:
							"The exact prompt sent to Pi for this one-shot run. This version finishes when the assistant turn ends normally.",
					},
				],
				submitLabel: "Run Prompt",
			},
			...promptLaunchResolution({
				processId: "single_prompt_process",
				startTurnId: "run_single_prompt",
			}),
		},
	})
	.define();

/** @internal */
export const singlePromptWithToolProcess: ExtensionProcessDefinition<
	PromptProcessParams,
	StructuralProcessState
> = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_with_tool_process")
	.displayName("Single Prompt + Done Tool")
	.entry("run_single_prompt_with_tool")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt_with_tool")
			.description("Run Prompt")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptWithToolInstruction(ctx.params.prompt))
			.outcomeTool("done", (tool) =>
				tool
					.description("Mark the prompt run as complete")
					.requiredString("summary", "Short summary of the result")
					.complete(),
			),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_with_tool_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_with_tool_process.single_prompt_with_tool_ui",
		label: "Single Prompt + Done Tool",
		description: "Run one prompt and require an explicit done tool",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt + Done Tool",
				description:
					"Run a one-shot prompt and force an explicit done tool call. The shared launcher shell chooses the model configuration.",
			},
			launchConfigSchema: {
				id: "single_prompt_with_tool_form",
				title: "Single Prompt + Done Tool",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello, then call the done tool with a short summary.",
						description:
							"The exact prompt sent to Pi for this one-shot run. This version requires the explicit done outcome tool.",
					},
				],
				submitLabel: "Run Prompt + Tool",
			},
			...promptLaunchResolution({
				processId: "single_prompt_with_tool_process",
				startTurnId: "run_single_prompt_with_tool",
			}),
		},
	})
	.define();

type SmokeOutcomeBuilder = AutomaticOutcomeBuilder<PromptProcessParams, StructuralProcessState>;
type SmokeRunFn = (ctx: {
	params: PromptProcessParams;
}) =>
	| { params: Record<string, unknown>; markdown: string }
	| Promise<{ params: Record<string, unknown>; markdown: string }>;

/**
 * Builds one of the Kubernetes smoke fixtures: an automatic worker run turn that
 * hands off to a wait turn with a `complete` action (and an optional `run_again`
 * action), plus a UI launcher. The three fixtures share this skeleton and differ
 * only in their ids, run body, and outcome parameter shape.
 */
function defineK8sSmokeProcess(args: {
	processId: string;
	displayName: string;
	runTurnId: string;
	waitTurnId: string;
	runTurnDescription: string;
	outcomeDescription: string;
	describeOutcome?: (outcome: SmokeOutcomeBuilder) => void;
	waitDescription: string;
	waitCommentary?: string;
	runAgain?: { label: string; description: string };
	completeLabel: string;
	launcherId: string;
	launcherDescription: string;
	cardDescription: string;
	formId: string;
	submitLabel: string;
	promptField?: { label: string };
	defaultPrompt: string;
	titleLabel: string;
	run: SmokeRunFn;
}): ExtensionProcessDefinition<PromptProcessParams, StructuralProcessState> {
	const promptField = args.promptField;
	const resolveLaunchConfig = promptField
		? (input: Record<string, unknown>) => {
				const validated = validateLaunchInput(input, args.defaultPrompt);
				if (!validated.ok) return validated;
				return {
					ok: true as const,
					launchConfig: {
						processId: args.processId,
						params: { prompt: validated.prompt },
						titleSourceFields: buildPromptTitleSourceFields(validated.prompt, args.titleLabel),
						startTurnId: args.runTurnId,
					},
				};
			}
		: () => ({
				ok: true as const,
				launchConfig: {
					processId: args.processId,
					params: { prompt: args.defaultPrompt },
					titleSourceFields: buildPromptTitleSourceFields(args.defaultPrompt, args.titleLabel),
					startTurnId: args.runTurnId,
				},
			});

	const runTurn = flow
		.automatic<PromptProcessParams, StructuralProcessState>(args.runTurnId)
		.description(args.runTurnDescription)
		.run(async (ctx) => {
			const result = await args.run(ctx);
			return { outcome: "ready" as const, ...result };
		})
		.outcome("ready", (outcome) => {
			outcome.description(args.outcomeDescription);
			args.describeOutcome?.(outcome);
			return outcome.to(args.waitTurnId);
		});

	const waitTurn: HumanFlowBuilder<PromptProcessParams, StructuralProcessState> = flow
		.human<PromptProcessParams, StructuralProcessState>(args.waitTurnId)
		.description(args.waitDescription);
	if (args.waitCommentary) {
		waitTurn.commentary(args.waitCommentary);
	}
	if (args.runAgain) {
		const runAgain = args.runAgain;
		waitTurn.action("run_again", (action) =>
			action
				.label(runAgain.label)
				.description(runAgain.description)
				.acceptanceState("neutral")
				.to(args.runTurnId),
		);
	}
	waitTurn.action("complete", (action) =>
		action.label(args.completeLabel).acceptanceState("accepted").complete(),
	);

	return flow
		.process<PromptProcessParams, StructuralProcessState>(args.processId)
		.displayName(args.displayName)
		.entry(args.runTurnId)
		.codecs({ params: promptProcessParamsCodec, state: structuralStateCodec })
		.initialState(() => createEmptyStructuralProcessState())
		.turn(runTurn)
		.turn(waitTurn)
		.launcher({
			id: args.launcherId,
			label: args.displayName,
			description: args.launcherDescription,
			visibility: "ui",
			ui: {
				card: { title: args.displayName, description: args.cardDescription },
				launchConfigSchema: {
					id: args.formId,
					title: args.displayName,
					fields: promptField
						? [{ id: "prompt", label: promptField.label, kind: "text", required: true }]
						: [],
					submitLabel: args.submitLabel,
				},
				...(promptField ? { resolveDefaults: () => ({ prompt: args.defaultPrompt }) } : {}),
				resolveLaunchConfig,
			},
		})
		.define();
}

/** @internal */
export const k8sSmokeProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_process",
	displayName: "Kubernetes Smoke",
	runTurnId: "k8s_smoke_run",
	waitTurnId: "k8s_smoke_wait",
	runTurnDescription: "Run a deterministic worker-side Kubernetes smoke step",
	outcomeDescription: "The worker-side smoke step completed",
	describeOutcome: (outcome) => outcome.string("prompt", "The smoke prompt"),
	waitDescription: "Wait after the Kubernetes smoke worker step",
	waitCommentary: "The smoke worker is idle; actions can respawn it on the retained PVC.",
	runAgain: { label: "Run smoke again", description: "Select the worker-side smoke turn again." },
	completeLabel: "Complete smoke",
	launcherId: "k8s_smoke_process.k8s_smoke_ui",
	launcherDescription: "Run a deterministic worker-backed Kubernetes smoke process",
	cardDescription: "Creates a worker pod/PVC and then waits for a follow-up action.",
	formId: "k8s_smoke_form",
	submitLabel: "Run smoke",
	promptField: { label: "Smoke prompt" },
	defaultPrompt: "kind smoke",
	titleLabel: "Smoke",
	run: (ctx) => ({
		params: { prompt: ctx.params.prompt },
		markdown: `Kubernetes smoke worker ran: ${ctx.params.prompt}`,
	}),
});

/** @internal */
export const k8sSmokeSpecializedProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_specialized_process",
	displayName: "Kubernetes Specialized Smoke",
	runTurnId: "k8s_smoke_specialized_run",
	waitTurnId: "k8s_smoke_specialized_wait",
	runTurnDescription: "Verify the specialized Kubernetes worker image tool path",
	outcomeDescription: "The specialized image tool ran",
	describeOutcome: (outcome) => outcome.requiredString("output", "Tool output"),
	waitDescription: "Wait after specialized image verification",
	waitCommentary: "The specialized Kubernetes image was selected and executed its smoke tool.",
	completeLabel: "Complete specialized smoke",
	launcherId: "k8s_smoke_specialized_process.k8s_smoke_specialized_ui",
	launcherDescription: "Run a deterministic worker-backed process on the specialized smoke image",
	cardDescription: "Validates runtime-profile image selection with a deterministic tool.",
	formId: "k8s_smoke_specialized_form",
	submitLabel: "Run specialized smoke",
	defaultPrompt: "specialized",
	titleLabel: "Smoke",
	run: () => {
		const output = execFileSync("leitwerk-specialized-tool", { encoding: "utf8" }).trim();
		return { params: { output }, markdown: output };
	},
});

/** @internal */
export const k8sSmokeLongProcess = defineK8sSmokeProcess({
	processId: "k8s_smoke_long_process",
	displayName: "Kubernetes Long Smoke",
	runTurnId: "k8s_smoke_long_run",
	waitTurnId: "k8s_smoke_long_wait",
	runTurnDescription: "Stay busy long enough for server restart adoption tests",
	outcomeDescription: "The long smoke step completed",
	waitDescription: "Wait after long smoke",
	completeLabel: "Complete long smoke",
	launcherId: "k8s_smoke_long_process.k8s_smoke_long_ui",
	launcherDescription: "Run a long worker-backed process for server restart adoption tests",
	cardDescription: "Keeps a worker pod busy while the server restarts.",
	formId: "k8s_smoke_long_form",
	submitLabel: "Run long smoke",
	defaultPrompt: "long",
	titleLabel: "Smoke",
	run: async () => {
		await delay(90_000);
		return { params: {}, markdown: "long smoke completed" };
	},
});

/** @internal */
export const singlePromptExternalCompleteProcess: ExtensionProcessDefinition<
	PromptProcessParams,
	StructuralProcessState
> = flow
	.process<PromptProcessParams, StructuralProcessState>("single_prompt_external_complete_process")
	.displayName("Single Prompt + External Complete")
	.entry("run_single_prompt")
	.codecs({
		params: promptProcessParamsCodec,
		state: structuralStateCodec,
	})
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<PromptProcessParams, StructuralProcessState>("run_single_prompt")
			.description("Run Prompt")
			.tools("read", "bash", "edit", "write")
			.prompt(async (ctx) => buildSinglePromptInstruction(ctx.params.prompt))
			.end("completed")
			.to(externalPromptCompletionTurnId),
	)
	.turn(
		flow
			.external<PromptProcessParams, StructuralProcessState>(externalPromptCompletionTurnId)
			.description(externalPromptCompletionTurnDescription)
			.from(
				fileExternal.presence({
					path: "/tmp/complete-prompt",
					pollInterval: "1s",
					consume: "delete",
				}),
			)
			.complete(),
	)
	.ui((api) => {
		api.leafOutcome(
			createMarkdownLeafOutcome(
				"@leitwerk-dev/showcase-processes:single_prompt_external_complete_process.leaf_outcome",
			),
		);
	})
	.launcher({
		id: "single_prompt_external_complete_process.single_prompt_external_complete_ui",
		label: "Single Prompt + External Complete",
		description: "Run one prompt, then wait for the external complete trigger file",
		visibility: "ui",
		ui: {
			card: {
				title: "Single Prompt + External Complete",
				description:
					"Run a one-shot prompt, preserve its result in the chronicle, and finish only when the external completion trigger fires.",
			},
			launchConfigSchema: {
				id: "single_prompt_external_complete_form",
				title: "Single Prompt + External Complete",
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: "Say hello, then wait for the external completion file.",
						description:
							"The prompt runs once. After it finishes, the process waits for the configured prompt-complete trigger file (default: /tmp/complete-prompt).",
					},
				],
				submitLabel: "Run Prompt",
			},
			...promptLaunchResolution({
				processId: "single_prompt_external_complete_process",
				startTurnId: "run_single_prompt",
			}),
		},
	})
	.define();
