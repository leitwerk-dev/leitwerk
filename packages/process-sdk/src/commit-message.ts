/** @internal */
export const COMMIT_MESSAGE_PROJECT_METADATA_KEY = "leitwerk.commitMessage";

/** @internal */
export const BUILT_IN_COMMIT_MESSAGE_RULES =
	"Write a concise imperative subject that summarizes the accepted plan. Add a body only when it provides useful context.";

/** @internal */
export interface CommitMessageProjectMetadata {
	/** @internal */
	templateId: string | null;
	/** @internal */
	rules: string;
}
