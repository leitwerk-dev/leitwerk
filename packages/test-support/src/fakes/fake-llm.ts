/** @public */
export interface LlmResponse {
	/** @public */
	content: string;
	/** @public */
	toolCalls?: Array<{
		/** @public */
		name: string;
		/** @public */
		arguments: Record<string, unknown>;
	}>;
}

/** @public */
export type LlmHandler = (prompt: string) => LlmResponse;

/**
 * Deterministic in-memory LLM fake for automated system tests.
 * Responds with scripted outputs based on registered handlers.
 */
/** @public */
export class FakeLlmProvider {
	private handlers: LlmHandler[] = [];
	private callIndex = 0;
	/** @public */
	readonly calls: string[] = [];

	/** @public */
	onPrompt(handler: LlmHandler): void {
		this.handlers.push(handler);
	}

	/** @public */
	respond(prompt: string): LlmResponse {
		this.calls.push(prompt);
		const handler = this.handlers[this.callIndex % this.handlers.length];
		if (handler) {
			this.callIndex++;
			return handler(prompt);
		}
		return { content: "No handler registered for this prompt." };
	}

	/** @internal */
	reset(): void {
		this.handlers = [];
		this.callIndex = 0;
		this.calls.length = 0;
	}
}
