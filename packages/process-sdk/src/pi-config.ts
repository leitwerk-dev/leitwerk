import { homedir } from "node:os";
import type { ConfigSnapshot } from "@leitwerk-dev/protocol";
import Mustache from "mustache";
import type { LlmTurnDefinition } from "./define-process.js";
import {
	PI_BUILT_IN_TOOL_NAMES,
	type PiBuiltInToolName,
	type ProcessPiConfig,
	type ResolvedProcessPiConfig,
} from "./types.js";

type TemplateScalar = string | number | boolean;
type TemplateValue = TemplateScalar | TemplateContext | readonly TemplateValue[] | undefined;

export interface TemplateContext {
	[key: string]: TemplateValue;
}

function isScalarValue(value: unknown): value is string | number | boolean {
	return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function toTemplateContextRecord(value: unknown): TemplateContext {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	const context: TemplateContext = {};
	for (const [key, candidate] of Object.entries(value)) {
		if (isScalarValue(candidate)) {
			context[key] = candidate;
		}
	}
	return context;
}

export function createTemplateContext(input: {
	params?: unknown;
	process?: {
		processId?: string | null;
		externalId?: string | null;
		externalUrl?: string | null;
		selectedTurnId?: string | null;
	};
	projects?: ReadonlyArray<{
		key: string;
		repoLocator: string;
		baseBranch: string;
		workBranch?: string | null;
	}>;
}): TemplateContext {
	const context: TemplateContext = {
		...toTemplateContextRecord(input.params),
	};
	if (input.process) {
		context.processId = input.process.processId ?? undefined;
		context.externalId = input.process.externalId ?? undefined;
		context.externalUrl = input.process.externalUrl ?? undefined;
		context.selectedTurnId = input.process.selectedTurnId ?? undefined;
	}
	const firstProject = input.projects?.[0];
	if (firstProject) {
		context.projectKey = firstProject.key;
		context.repositoryUrl = firstProject.repoLocator;
		context.baseBranch = firstProject.baseBranch;
		context.workBranch = firstProject.workBranch ?? undefined;
	}
	return context;
}

export function interpolateTemplate(template: string, context: TemplateContext): string {
	return Mustache.render(template, context);
}

type TurnToolDefinitionLike =
	| { kind: "llm"; availableTools: readonly PiBuiltInToolName[] }
	| { kind: string };

type ProcessTurnBindingLike = {
	definition: TurnToolDefinitionLike;
};

type ProcessToolSource = TurnToolDefinitionLike | ProcessTurnBindingLike;

function isTurnDefinitionSource(source: ProcessToolSource): source is TurnToolDefinitionLike {
	return "kind" in source;
}

function resolveToolSourceDefinition(source: ProcessToolSource): TurnToolDefinitionLike {
	return isTurnDefinitionSource(source) ? source : source.definition;
}

export function validatePiBuiltInToolArray(
	toolNames: readonly unknown[],
	context: string,
): string[] {
	const errors: string[] = [];
	const seen = new Set<string>();
	for (const rawName of toolNames) {
		if (typeof rawName !== "string") {
			errors.push(`${context} must contain only string tool names`);
			continue;
		}
		const name = rawName.trim();
		if (name === "") {
			errors.push(`${context} must not contain empty tool names`);
			continue;
		}
		if (name !== rawName) {
			errors.push(`${context} must use canonical Pi tool names without surrounding whitespace`);
			continue;
		}
		if (!PI_BUILT_IN_TOOL_NAMES.includes(name as PiBuiltInToolName)) {
			errors.push(
				`${context} references unknown Pi tool '${name}'. Expected one of ${PI_BUILT_IN_TOOL_NAMES.join(", ")}`,
			);
			continue;
		}
		if (seen.has(name)) {
			errors.push(`${context} must not contain duplicate Pi tool '${name}'`);
			continue;
		}
		seen.add(name);
	}
	return errors;
}

export function resolveTurnAvailableToolNames(input: {
	turnId: string;
	turnDef: LlmTurnDefinition<string, unknown, unknown>;
}): string[] {
	const errors = validatePiBuiltInToolArray(
		input.turnDef.availableTools,
		`turn '${input.turnId}' availableTools`,
	);
	if (errors.length > 0) {
		throw new Error(errors.join("; "));
	}
	return [...input.turnDef.availableTools];
}

export function collectProcessAvailableToolNames(
	turns: Iterable<ProcessToolSource> | undefined,
): string[] {
	const usedToolNames = new Set<PiBuiltInToolName>();
	for (const source of turns ?? []) {
		const definition = resolveToolSourceDefinition(source);
		if (definition.kind !== "llm" || !("availableTools" in definition)) {
			continue;
		}
		const errors = validatePiBuiltInToolArray(definition.availableTools, "LLM turn availableTools");
		if (errors.length > 0) {
			throw new Error(errors.join("; "));
		}
		for (const toolName of definition.availableTools) {
			usedToolNames.add(toolName);
		}
	}
	return PI_BUILT_IN_TOOL_NAMES.filter((toolName) => usedToolNames.has(toolName));
}

const DEFAULT_TOOL_DESCRIPTIONS: Record<PiBuiltInToolName, string> = {
	read: "Read file contents",
	bash: "Execute bash commands (ls, grep, find, etc.)",
	edit: "Make surgical edits to files (find exact text and replace)",
	write: "Create or overwrite files",
	grep: "Search file contents",
	find: "Find files by name/path",
	ls: "List directory contents",
};

function buildDefaultSystemPrompt(availableToolNames: readonly string[]): string {
	const toolList =
		availableToolNames.length > 0
			? availableToolNames
					.map((toolName) => {
						const description =
							DEFAULT_TOOL_DESCRIPTIONS[toolName as PiBuiltInToolName] ?? "Built-in Pi tool";
						return `- ${toolName}: ${description}`;
					})
					.join("\n")
			: "- No built-in tools are available for this process unless a turn registers custom tools.";
	return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by using the tools made available for the active turn.

Available built-in tools for this process:
${toolList}

In addition to the tools above, you may have access to other custom tools depending on the active turn.

Guidelines:
- Use only tools that are available in the active turn.
- Use read/search tools to examine files before editing.
- Use edit for precise changes when it is available (old text must match exactly).
- Use write only for new files or complete rewrites when it is available.
- When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did.
- Be concise in your responses.
- Show file paths clearly when working with files.`;
}

export function resolveProcessPiConfig(input: {
	processId: string;
	processPiConfig?: ProcessPiConfig;
	turns?: Iterable<ProcessToolSource>;
	configSnapshot?: ConfigSnapshot;
	templateContext: TemplateContext;
}): ResolvedProcessPiConfig {
	const processConfig = input.configSnapshot?.process_configs?.[input.processId];
	const processPiOverride = processConfig?.pi;
	const availableToolNames = collectProcessAvailableToolNames(input.turns);

	const configSystemPromptTemplate = input.configSnapshot?.pi?.system_prompt_template;
	const systemPromptTemplate =
		processPiOverride?.system_prompt_template ??
		input.processPiConfig?.systemPromptTemplate ??
		configSystemPromptTemplate;
	const appendSystemPromptTemplate =
		processPiOverride?.append_system_prompt_template ??
		input.processPiConfig?.appendSystemPromptTemplate;

	const resolvedSystemPrompt = systemPromptTemplate
		? interpolateTemplate(systemPromptTemplate, input.templateContext)
		: buildDefaultSystemPrompt(availableToolNames);
	const sessionCwd = input.processPiConfig?.sessionCwdTemplate
		? interpolateTemplate(input.processPiConfig.sessionCwdTemplate, input.templateContext).trim()
		: undefined;

	return {
		systemPrompt: resolvedSystemPrompt,
		appendSystemPrompt: appendSystemPromptTemplate
			? interpolateTemplate(appendSystemPromptTemplate, input.templateContext)
			: undefined,
		...(sessionCwd ? { sessionCwd } : {}),
		availableToolNames,
	};
}

export function resolveTurnActiveToolNames(input: {
	turnId: string;
	turnDef: LlmTurnDefinition<string, unknown, unknown>;
}): string[] {
	return resolveTurnAvailableToolNames(input);
}

// Mirror Pi's PI_CODING_AGENT_DIR expansion semantics from
// pi-mono/packages/coding-agent/src/config.ts.
export function expandPiAgentDir(agentDir: string): string {
	if (agentDir === "~") {
		return homedir();
	}
	if (agentDir.startsWith("~/")) {
		return homedir() + agentDir.slice(1);
	}
	return agentDir;
}

export function resolvePiAgentDir(options: {
	agentDir?: string | null;
	configSnapshot?: ConfigSnapshot;
	fallbackDir: string;
}): string {
	const configuredAgentDir =
		typeof options.agentDir === "string" && options.agentDir.trim() !== ""
			? options.agentDir
			: typeof options.configSnapshot?.pi?.agent_dir === "string" &&
					options.configSnapshot.pi.agent_dir.trim() !== ""
				? options.configSnapshot.pi.agent_dir
				: options.fallbackDir;
	return expandPiAgentDir(configuredAgentDir);
}
