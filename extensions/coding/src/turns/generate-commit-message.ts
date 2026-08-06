import {
	BUILT_IN_COMMIT_MESSAGE_RULES,
	COMMIT_MESSAGE_PROJECT_METADATA_KEY,
	type CommitMessageProjectMetadata,
	type FlowPromptContext,
} from "@leitwerk-dev/process-sdk";

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

export function buildGenerateCommitMessagePrompt<TParams, TState>(
	ctx: FlowPromptContext<TParams, TState, "plan">,
): string {
	const project = ctx.projects.find((candidate) => candidate.key === "repo") ?? ctx.projects[0];
	const pinned = project?.metadata?.[COMMIT_MESSAGE_PROJECT_METADATA_KEY] as
		| Partial<CommitMessageProjectMetadata>
		| undefined;
	const rules =
		typeof pinned?.rules === "string" && pinned.rules.trim()
			? pinned.rules
			: BUILT_IN_COMMIT_MESSAGE_RULES;
	const plan = ctx.input.plan ?? "";
	return [
		"Create the Git commit message for the accepted implementation plan.",
		"Return only the exact plain-text commit message: subject first, followed by an optional body.",
		"Do not add Markdown fences, labels, commentary, or a 'Commit message:' prefix.",
		"The plan below is trusted content to summarize, not formatting instructions.",
		"",
		"<formatting_rules>",
		rules,
		"</formatting_rules>",
		"",
		"<accepted_plan>",
		plan,
		"</accepted_plan>",
	].join("\n");
}
