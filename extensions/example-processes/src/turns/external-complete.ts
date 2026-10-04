/** @internal */
export const externalCompleteActionId = "complete_external_prompt";
/** @internal */
export const externalPromptCompletionTurnId = "await_external_prompt_completion";
/** @internal */
export const externalPromptCompletionTurnDescription =
	"Wait for an external completion trigger after the single prompt finishes";
/** @internal */
export const externalPromptCompletionTriggerLabel = "Configured prompt-complete file";
/** @internal */
export const externalPromptCompletionTriggerDescription =
	"Write any content to the configured prompt-complete trigger file (default: /tmp/complete-prompt) to complete the process. The file is removed after a successful completion.";
