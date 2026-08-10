interface CorrelatedPayload {
	turnRecordId: string;
	toolCallId: string;
}

interface PendingRequest<TRequest> {
	payload: TRequest;
	resolve(value: unknown): void;
	reject(error: Error): void;
	removeAbort(): void;
}

export class ReplayingRequestBridge<
	TRequest extends CorrelatedPayload,
	TResponse extends CorrelatedPayload,
	TResult,
> {
	private readonly pending = new Map<string, PendingRequest<TRequest>>();

	constructor(
		private readonly emit: (payload: TRequest) => void,
		private readonly resolveResponse: (payload: TResponse) => TResult,
	) {}

	request(payload: TRequest, signal: AbortSignal, cancellationError: string): Promise<TResult> {
		if (this.pending.has(payload.toolCallId)) {
			return Promise.reject(new Error(`Duplicate in-flight request '${payload.toolCallId}'`));
		}
		return new Promise<TResult>((resolve, reject) => {
			const onAbort = () => {
				this.pending.delete(payload.toolCallId);
				reject(new Error(cancellationError));
			};
			signal.addEventListener("abort", onAbort, { once: true });
			this.pending.set(payload.toolCallId, {
				payload,
				resolve,
				reject,
				removeAbort: () => signal.removeEventListener("abort", onAbort),
			});
			this.emit(payload);
		});
	}

	handle(payload: TResponse): boolean {
		const pending = this.pending.get(payload.toolCallId);
		if (!pending || pending.payload.turnRecordId !== payload.turnRecordId) return false;
		this.pending.delete(payload.toolCallId);
		pending.removeAbort();
		try {
			pending.resolve(this.resolveResponse(payload));
		} catch (error) {
			pending.reject(error instanceof Error ? error : new Error(String(error)));
		}
		return true;
	}

	replay(): void {
		for (const pending of this.pending.values()) this.emit(pending.payload);
	}

	cancelAll(reason: string): void {
		for (const pending of this.pending.values()) {
			pending.removeAbort();
			pending.reject(new Error(reason));
		}
		this.pending.clear();
	}
}
