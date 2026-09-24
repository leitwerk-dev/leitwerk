import {
	type Codec,
	createEmptyStructuralProcessState,
	flow,
	type LeitwerkExtensionModule,
	type StructuralProcessState,
	structuralStateCodec,
} from "@leitwerk-dev/process-sdk";

interface Params {
	prompt: string;
}

const paramsCodec: Codec<Params> = {
	parse(value) {
		if (
			typeof value !== "object" ||
			value === null ||
			!("prompt" in value) ||
			typeof value.prompt !== "string" ||
			value.prompt.trim() === ""
		) {
			throw new Error("prompt must be a nonempty string");
		}
		return { prompt: value.prompt.trim() };
	},
	serialize(value) {
		return { prompt: value.prompt };
	},
};

/** @internal */
export const firstProcess = flow
	.process<Params, StructuralProcessState>("first_process")
	.displayName("First Process")
	.entry("draft")
	.happyPath("draft", "review")
	.codecs({ params: paramsCodec, state: structuralStateCodec })
	.initialState(() => createEmptyStructuralProcessState())
	.turn(
		flow
			.llm<Params, StructuralProcessState>("draft")
			.description("Draft a response")
			.freshPrimary()
			.buildPrompt((ctx) => ctx.params.prompt)
			.publish("draft")
			.to("review"),
	)
	.turn(
		flow
			.human<Params, StructuralProcessState>("review")
			.description("Review the response")
			.reviewProduct("draft")
			.action("accept", (action) => action.label("Accept").complete()),
	)
	.launcher({
		id: "first_process.start",
		label: "First Process",
		description: "Draft a response and review it",
		visibility: "ui",
		ui: {
			card: { title: "First Process", description: "Draft, then review" },
			launchConfigSchema: {
				id: "first_process_input",
				title: "Start a draft",
				fields: [{ id: "prompt", label: "Prompt", kind: "textarea", required: true }],
				submitLabel: "Start",
			},
			resolveLaunchConfig(input) {
				if (typeof input.prompt !== "string" || input.prompt.trim() === "") {
					return {
						ok: false,
						errors: [{ code: "required", fieldId: "prompt", message: "Enter a prompt" }],
					};
				}
				return {
					ok: true,
					launchConfig: {
						processId: "first_process",
						startTurnId: "draft",
						params: paramsCodec.parse(input),
					},
				};
			},
		},
	})
	.define();

const extension: LeitwerkExtensionModule = {
	manifest: { id: "first-process", version: "0.1.0" },
	setupCatalog(api) {
		api.registerProcess(firstProcess);
	},
};

/** @internal */
export default extension;
