export interface LlmResponse {
	content: string;
	toolCalls?: Array<{
		name: string;
		arguments: Record<string, unknown>;
	}>;
}

export type LlmHandler = (prompt: string) => LlmResponse;

/**
 * Deterministic in-memory LLM fake for automated system tests.
 * Responds with scripted outputs based on registered handlers.
 */
export class FakeLlmProvider {
	private handlers: LlmHandler[] = [];
	private callIndex = 0;
	readonly calls: string[] = [];

	onPrompt(handler: LlmHandler): void {
		this.handlers.push(handler);
	}

	respond(prompt: string): LlmResponse {
		this.calls.push(prompt);
		const handler = this.handlers[this.callIndex % this.handlers.length];
		if (handler) {
			this.callIndex++;
			return handler(prompt);
		}
		return { content: "No handler registered for this prompt." };
	}

	reset(): void {
		this.handlers = [];
		this.callIndex = 0;
		this.calls.length = 0;
	}
}
