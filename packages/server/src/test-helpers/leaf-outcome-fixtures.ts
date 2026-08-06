import type {
	Codec,
	ExtensionProcessDefinition,
	LeitwerkExtensionModule,
	LlmTurnDefinition,
	ProcessLeafOutcomeDefinition,
	StructuralProcessState,
} from "@leitwerk-dev/process-sdk";
import { defineProcess, llmTurn } from "@leitwerk-dev/process-sdk";
import {
	createStructuralProcessState,
	createStructuralStateJson,
	structuralProcessStateCodec,
} from "./structural-process-fixtures.js";

export const leafOutcomePromptParamsCodec: Codec<{ prompt: string }> = {
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

export const leafOutcomeStructuralStateCodec: Codec<StructuralProcessState> =
	structuralProcessStateCodec;

type LeafOutcomeResultSemanticRef = NonNullable<
	LlmTurnDefinition<"completed">["resultSemanticRef"]
>;

export interface CreateLeafOutcomeCaptureTurnOptions {
	description?: string;
	branchType?: LlmTurnDefinition<"completed">["branchType"];
	context?: LlmTurnDefinition<"completed">["context"];
	promptText?: string;
	resultSemanticRef?: LeafOutcomeResultSemanticRef;
	turnResultMarkdown?: LlmTurnDefinition<"completed">["turnResultMarkdown"];
}

export function createLeafOutcomeCaptureTurn(
	turnId: string,
	options: CreateLeafOutcomeCaptureTurnOptions = {},
): LlmTurnDefinition<"completed", { prompt: string }, StructuralProcessState> {
	return llmTurn<{ prompt: string }, StructuralProcessState, "completed">({
		description: options.description ?? "Produce a captured leaf outcome",
		availableTools: [],
		completionMode: "turn_end",
		branchType: options.branchType ?? "primary",
		context: options.context ?? "fresh",
		prompt: async () => options.promptText ?? turnId,
		outcomes: {},
		turnEnd: {
			outcome: "completed",
			params: {},
			complete: true,
		},
		...(options.turnResultMarkdown ? { turnResultMarkdown: options.turnResultMarkdown } : {}),
		resultSemanticRef: options.resultSemanticRef ?? "plan",
	});
}

export interface CreateLeafOutcomeTestProcessDefinitionOptions {
	displayName?: string;
	resultSemanticRef?: LeafOutcomeResultSemanticRef;
}

export function createLeafOutcomeTestProcessDefinition(
	processId: string,
	rendererId: string,
	turnId: string,
	capture: ProcessLeafOutcomeDefinition<{ prompt: string }, StructuralProcessState>["capture"],
	options: CreateLeafOutcomeTestProcessDefinitionOptions = {},
): ExtensionProcessDefinition<{ prompt: string }, StructuralProcessState> {
	return defineProcess({
		id: processId,
		displayName: options.displayName ?? processId,
		entry: turnId,
		turns: {
			[turnId]: createLeafOutcomeCaptureTurn(turnId, {
				resultSemanticRef: options.resultSemanticRef ?? "plan",
			}),
		},
		paramsCodec: leafOutcomePromptParamsCodec,
		stateCodec: leafOutcomeStructuralStateCodec,
		initialState() {
			return createStructuralProcessState();
		},
		worker(api) {
			api.start(turnId);
		},
		ui(api) {
			api.leafOutcome({
				rendererId,
				capture,
			});
		},
	});
}

export interface CreateLeafOutcomeTestExtensionModuleOptions {
	manifestId?: string;
	manifestVersion?: string;
	turn?: CreateLeafOutcomeCaptureTurnOptions;
}

export function createLeafOutcomeTestExtensionModule(
	processDef: ExtensionProcessDefinition<{ prompt: string }, StructuralProcessState>,
	_turnId: string,
	options: CreateLeafOutcomeTestExtensionModuleOptions = {},
): LeitwerkExtensionModule {
	return {
		manifest: {
			id: options.manifestId ?? `${processDef.id}-test`,
			version: options.manifestVersion ?? "0.1.0",
		},
		setupCatalog(api) {
			api.registerProcess(processDef);
		},
	};
}

export function createLeafOutcomeBaseStateJson(
	rootEntryId: string,
	overrides: Partial<StructuralProcessState["semanticEntryRefs"]> = {},
): string {
	return createStructuralStateJson({
		semanticEntryRefs: {
			rootEntry: { entryId: rootEntryId, turnRecordId: null },
			currentPrimaryPathLeaf: { entryId: rootEntryId, turnRecordId: null },
			...overrides,
		},
	});
}
