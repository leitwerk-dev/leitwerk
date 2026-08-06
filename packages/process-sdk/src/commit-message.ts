export const COMMIT_MESSAGE_PROJECT_METADATA_KEY = "leitwerk.commitMessage";

export const BUILT_IN_COMMIT_MESSAGE_RULES =
	"Write a concise imperative subject that summarizes the accepted plan. Add a body only when it provides useful context.";

export interface CommitMessageProjectMetadata {
	templateId: string | null;
	rules: string;
}
