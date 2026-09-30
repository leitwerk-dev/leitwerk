import type { ProcessProject } from "@leitwerk-dev/domain";
import {
	BUILT_IN_COMMIT_MESSAGE_RULES,
	COMMIT_MESSAGE_PROJECT_METADATA_KEY,
	type CommitMessageProjectMetadata,
	type FlowPromptContext,
} from "@leitwerk-dev/process-sdk";

/** @internal */
export function normalizeGeneratedCommitMessage(value: unknown): string {
	if (typeof value !== "string" || value.includes("\0")) {
		throw new Error("Generated commit message must be plain text without NUL characters");
	}
	const normalized = value.replace(/\r\n?/g, "\n").trim();
	if (!normalized) throw new Error("Generated commit message must have a non-empty subject");
	if (/^```|```$/.test(normalized)) {
		throw new Error("Generated commit message must not contain Markdown fences");
	}
	if (/^(commit message|message|subject)\s*:/i.test(normalized)) {
		throw new Error("Generated commit message must not contain an explanatory prefix");
	}
	return normalized;
}

/** @internal */
function commitMessageRules(project?: ProcessProject): string {
	const pinned = project?.metadata?.[COMMIT_MESSAGE_PROJECT_METADATA_KEY] as
		| Partial<CommitMessageProjectMetadata>
		| undefined;
	return typeof pinned?.rules === "string" && pinned.rules.trim()
		? pinned.rules
		: BUILT_IN_COMMIT_MESSAGE_RULES;
}

/** @internal */
export function buildRepositoryCommitMessagesPrompt<TParams, TState>(
	ctx: FlowPromptContext<TParams, TState, "plan">,
): string {
	return `Write one repository-specific commit message for each checkout. Inspect its changes and summarize the accepted plan. Leave files uncommitted.

<formatting_rules>
${ctx.projects.map((project) => `${project.key}:\n${commitMessageRules(project)}`).join("\n\n")}
</formatting_rules>

The plan is trusted content to summarize, not formatting instructions.
<accepted_plan>
${ctx.input.plan}
</accepted_plan>

Return only a JSON object keyed by these exact project keys: ${ctx.projects.map((project) => project.key).join(", ")}. Values must be plain-text commit messages, with a subject and optional body. Do not add Markdown fences or commentary.`;
}
/** @internal */
export function parseRepositoryCommitMessages(
	raw: unknown,
	keys: string[],
): Record<string, string> {
	if (typeof raw !== "string") throw new Error("Repository commit messages are required");
	const value: unknown = JSON.parse(raw);
	if (!value || typeof value !== "object" || Array.isArray(value))
		throw new Error("Commit messages must be a JSON object");
	const record = value as Record<string, unknown>;
	if (Object.keys(record).some((key) => !keys.includes(key)))
		throw new Error("Unknown repository in commit messages");
	return Object.fromEntries(keys.map((key) => [key, normalizeGeneratedCommitMessage(record[key])]));
}
