/** @internal */
export function buildSinglePromptInstruction(promptText: string): string {
	return `Run the following one-shot operator prompt exactly once.

${promptText}`;
}

/** @internal */
export function buildSinglePromptWithToolInstruction(promptText: string): string {
	return `Run the following one-shot operator prompt exactly once.

${promptText}

When you are done, call the done tool with a short summary of the result.`;
}
