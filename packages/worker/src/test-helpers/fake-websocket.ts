export class FakeWorkerWebSocket {
	static instances: FakeWorkerWebSocket[] = [];
	readonly url: string;
	readyState = 0;
	sent: string[] = [];
	throwOnSend = false;
	private listeners = new Map<string, Set<(event?: unknown) => void>>();

	constructor(url: string) {
		this.url = url;
		FakeWorkerWebSocket.instances.push(this);
	}

	addEventListener(event: string, handler: (event?: unknown) => void): void {
		const existing = this.listeners.get(event) ?? new Set();
		existing.add(handler);
		this.listeners.set(event, existing);
	}

	emit(event: string, payload?: unknown): void {
		for (const handler of this.listeners.get(event) ?? []) {
			handler(payload);
		}
	}

	open(): void {
		this.readyState = 1;
		this.emit("open");
	}

	receive(data: string): void {
		this.emit("message", { data });
	}

	send(data: string): void {
		if (this.throwOnSend) {
			throw new Error("send failed");
		}
		this.sent.push(data);
	}

	close(code?: number, reason?: string): void {
		this.readyState = 3;
		this.emit("close", { code, reason });
	}
}
