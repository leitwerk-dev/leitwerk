import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import {
	type AutomaticOutcomeBuilder,
	type Codec,
	createEmptyStructuralProcessState,
	type ExtensionProcessDefinition,
	flow,
	type HumanFlowBuilder,
	type ProcessLauncherDefinition,
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
		const record =
			typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
		return { prompt: typeof record.prompt === "string" ? record.prompt : "" };
	},
	serialize(value) {
		return value;
	},
};

function promptLaunchResolution(options: {
	processId: string;
	startTurnId: string;
	defaultPrompt?: () => string;
	titleLabel?: string;
}) {
	return {
		resolveDefaults: () => ({ prompt: options.defaultPrompt?.() ?? "" }),
		resolveLaunchConfig(input: Record<string, unknown>) {
			const inputPrompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
			const prompt = inputPrompt || options.defaultPrompt?.().trim() || "";
			if (!prompt) {
				return {
					ok: false as const,
					errors: [{ code: "required", fieldId: "prompt", message: "prompt is required" }],
				};
			}
			return {
				ok: true as const,
				launchConfig: {
					processId: options.processId,
					params: { prompt },
					titleSourceFields: [{ label: options.titleLabel ?? "Prompt", value: prompt }],
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

function promptProcess(processId: string, displayName: string, entry: string) {
	return flow
		.process<PromptProcessParams, StructuralProcessState>(processId)
		.displayName(displayName)
		.entry(entry)
		.codecs({ params: promptProcessParamsCodec, state: structuralStateCodec })
		.initialState(createEmptyStructuralProcessState)
		.ui((api) =>
			api.leafOutcome(
				createMarkdownLeafOutcome(`@leitwerk-dev/showcase-processes:${processId}.leaf_outcome`),
			),
		);
}

function promptTurn(turnId: string, instruction = buildSinglePromptInstruction) {
	return flow
		.llm<PromptProcessParams, StructuralProcessState>(turnId)
		.description("Run Prompt")
		.tools("read", "bash", "edit", "write")
		.prompt((ctx) => instruction(ctx.params.prompt));
}

function promptLauncher(options: {
	processId: string;
	startTurnId: string;
	displayName: string;
	launcherId: string;
	formId: string;
	description: string;
	cardDescription: string;
	placeholder: string;
	promptDescription: string;
	submitLabel?: string;
}): ProcessLauncherDefinition<PromptProcessParams> {
	return {
		id: options.launcherId,
		label: options.displayName,
		description: options.description,
		visibility: "ui",
		ui: {
			card: { title: options.displayName, description: options.cardDescription },
			launchConfigSchema: {
				id: options.formId,
				title: options.displayName,
				fields: [
					{
						id: "prompt",
						label: "Prompt",
						kind: "textarea",
						required: true,
						placeholder: options.placeholder,
						description: options.promptDescription,
					},
				],
				submitLabel: options.submitLabel ?? "Run Prompt",
			},
			...promptLaunchResolution(options),
		},
	};
}

/** @internal */
export const singlePromptProcess = promptProcess(
	"single_prompt_process",
	"Single Prompt",
	"run_single_prompt",
)
	.turn(promptTurn("run_single_prompt").end("completed").complete())
	.launcher(
		promptLauncher({
			processId: "single_prompt_process",
			startTurnId: "run_single_prompt",
			displayName: "Single Prompt",
			launcherId: "single_prompt_process.single_prompt_ui",
			formId: "single_prompt_form",
			description: "Run one prompt and finish on turn end",
			cardDescription:
				"Run a one-shot prompt. The shared launcher shell chooses the model configuration.",
			placeholder: "Say hello.",
			promptDescription:
				"The exact prompt sent to Pi for this one-shot run. This version finishes when the assistant turn ends normally.",
		}),
	)
	.define();

/** @internal */
export const singlePromptWithToolProcess = promptProcess(
	"single_prompt_with_tool_process",
	"Single Prompt + Done Tool",
	"run_single_prompt_with_tool",
)
	.turn(
		promptTurn("run_single_prompt_with_tool", buildSinglePromptWithToolInstruction).outcomeTool(
			"done",
			(tool) =>
				tool
					.description("Mark the prompt run as complete")
					.requiredString("summary", "Short summary of the result")
					.complete(),
		),
	)
	.launcher(
		promptLauncher({
			processId: "single_prompt_with_tool_process",
			startTurnId: "run_single_prompt_with_tool",
			displayName: "Single Prompt + Done Tool",
			launcherId: "single_prompt_with_tool_process.single_prompt_with_tool_ui",
			formId: "single_prompt_with_tool_form",
			description: "Run one prompt and require an explicit done tool",
			cardDescription:
				"Run a one-shot prompt and force an explicit done tool call. The shared launcher shell chooses the model configuration.",
			placeholder: "Say hello, then call the done tool with a short summary.",
			promptDescription:
				"The exact prompt sent to Pi for this one-shot run. This version requires the explicit done outcome tool.",
			submitLabel: "Run Prompt + Tool",
		}),
	)
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
	baseId: string;
	displayName: string;
	runTurnDescription: string;
	outcomeDescription: string;
	describeOutcome?: (outcome: SmokeOutcomeBuilder) => void;
	waitDescription: string;
	waitCommentary?: string;
	runAgain?: { label: string; description: string };
	completeLabel: string;
	launcherDescription: string;
	cardDescription: string;
	submitLabel: string;
	promptField?: { label: string };
	defaultPrompt: string;
	run: SmokeRunFn;
}): ExtensionProcessDefinition<PromptProcessParams, StructuralProcessState> {
	const processId = `${args.baseId}_process`;
	const runTurnId = `${args.baseId}_run`;
	const waitTurnId = `${args.baseId}_wait`;
	const promptField = args.promptField;
	const launchResolution = promptLaunchResolution({
		processId,
		startTurnId: runTurnId,
		defaultPrompt: () => args.defaultPrompt,
		titleLabel: "Smoke",
	});

	const runTurn = flow
		.automatic<PromptProcessParams, StructuralProcessState>(runTurnId)
		.description(args.runTurnDescription)
		.run(async (ctx) => {
			const result = await args.run(ctx);
			return { outcome: "ready" as const, ...result };
		})
		.outcome("ready", (outcome) => {
			outcome.description(args.outcomeDescription);
			args.describeOutcome?.(outcome);
			return outcome.to(waitTurnId);
		});

	const waitTurn: HumanFlowBuilder<PromptProcessParams, StructuralProcessState> = flow
		.human<PromptProcessParams, StructuralProcessState>(waitTurnId)
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
				.to(runTurnId),
		);
	}
	waitTurn.action("complete", (action) =>
		action.label(args.completeLabel).acceptanceState("accepted").complete(),
	);

	return flow
		.process<PromptProcessParams, StructuralProcessState>(processId)
		.displayName(args.displayName)
		.entry(runTurnId)
		.codecs({ params: promptProcessParamsCodec, state: structuralStateCodec })
		.initialState(() => createEmptyStructuralProcessState())
		.turn(runTurn)
		.turn(waitTurn)
		.launcher({
			id: `${processId}.${args.baseId}_ui`,
			label: args.displayName,
			description: args.launcherDescription,
			visibility: "ui",
			ui: {
				card: { title: args.displayName, description: args.cardDescription },
				launchConfigSchema: {
					id: `${args.baseId}_form`,
					title: args.displayName,
					fields: promptField
						? [{ id: "prompt", label: promptField.label, kind: "text", required: true }]
						: [],
					submitLabel: args.submitLabel,
				},
				...(promptField ? { resolveDefaults: launchResolution.resolveDefaults } : {}),
				resolveLaunchConfig: (input) =>
					launchResolution.resolveLaunchConfig(promptField ? input : {}),
			},
		})
		.define();
}

/** @internal */
export const k8sSmokeProcess = defineK8sSmokeProcess({
	baseId: "k8s_smoke",
	displayName: "Kubernetes Smoke",
	runTurnDescription: "Run a deterministic worker-side Kubernetes smoke step",
	outcomeDescription: "The worker-side smoke step completed",
	describeOutcome: (outcome) => outcome.string("prompt", "The smoke prompt"),
	waitDescription: "Wait after the Kubernetes smoke worker step",
	waitCommentary: "The smoke worker is idle; actions can respawn it on the retained PVC.",
	runAgain: { label: "Run smoke again", description: "Select the worker-side smoke turn again." },
	completeLabel: "Complete smoke",
	launcherDescription: "Run a deterministic worker-backed Kubernetes smoke process",
	cardDescription: "Creates a worker pod/PVC and then waits for a follow-up action.",
	submitLabel: "Run smoke",
	promptField: { label: "Smoke prompt" },
	defaultPrompt: "kind smoke",
	run: (ctx) => ({
		params: { prompt: ctx.params.prompt },
		markdown: `Kubernetes smoke worker ran: ${ctx.params.prompt}`,
	}),
});

/** @internal */
export const k8sSmokeSpecializedProcess = defineK8sSmokeProcess({
	baseId: "k8s_smoke_specialized",
	displayName: "Kubernetes Specialized Smoke",
	runTurnDescription: "Verify the specialized Kubernetes worker image tool path",
	outcomeDescription: "The specialized image tool ran",
	describeOutcome: (outcome) => outcome.requiredString("output", "Tool output"),
	waitDescription: "Wait after specialized image verification",
	waitCommentary: "The specialized Kubernetes image was selected and executed its smoke tool.",
	completeLabel: "Complete specialized smoke",
	launcherDescription: "Run a deterministic worker-backed process on the specialized smoke image",
	cardDescription: "Validates runtime-profile image selection with a deterministic tool.",
	submitLabel: "Run specialized smoke",
	defaultPrompt: "specialized",
	run: () => {
		const output = execFileSync("leitwerk-specialized-tool", { encoding: "utf8" }).trim();
		return { params: { output }, markdown: output };
	},
});

/** @internal */
export const k8sSmokeLongProcess = defineK8sSmokeProcess({
	baseId: "k8s_smoke_long",
	displayName: "Kubernetes Long Smoke",
	runTurnDescription: "Stay busy long enough for server restart adoption tests",
	outcomeDescription: "The long smoke step completed",
	waitDescription: "Wait after long smoke",
	completeLabel: "Complete long smoke",
	launcherDescription: "Run a long worker-backed process for server restart adoption tests",
	cardDescription: "Keeps a worker pod busy while the server restarts.",
	submitLabel: "Run long smoke",
	defaultPrompt: "long",
	run: async () => {
		await delay(90_000);
		return { params: {}, markdown: "long smoke completed" };
	},
});

/** @internal */
export const singlePromptExternalCompleteProcess = promptProcess(
	"single_prompt_external_complete_process",
	"Single Prompt + External Complete",
	"run_single_prompt",
)
	.turn(promptTurn("run_single_prompt").end("completed").to(externalPromptCompletionTurnId))
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
	.launcher(
		promptLauncher({
			processId: "single_prompt_external_complete_process",
			startTurnId: "run_single_prompt",
			displayName: "Single Prompt + External Complete",
			launcherId: "single_prompt_external_complete_process.single_prompt_external_complete_ui",
			formId: "single_prompt_external_complete_form",
			description: "Run one prompt, then wait for the external complete trigger file",
			cardDescription:
				"Run a one-shot prompt, preserve its result in the chronicle, and finish only when the external completion trigger fires.",
			placeholder: "Say hello, then wait for the external completion file.",
			promptDescription:
				"The prompt runs once. After it finishes, the process waits for the configured prompt-complete trigger file (default: /tmp/complete-prompt).",
		}),
	)
	.define();
