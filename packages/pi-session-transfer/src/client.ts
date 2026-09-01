import { Readable } from "node:stream";
import type {
	ParsedTransferLink,
	SessionTransferAttemptWire,
} from "@leitwerk-dev/session-transfer";

export type RemoteTransferAttempt = SessionTransferAttemptWire;

async function responseError(response: Response): Promise<Error> {
	let message = `Transfer request failed with HTTP ${response.status}`;
	try {
		const body = (await response.json()) as { error?: unknown; code?: unknown };
		if (typeof body.error === "string") message = body.error;
		if (typeof body.code === "string") message = `${message} (${body.code})`;
	} catch {
		// Keep the generic status without exposing response bodies that may contain credentials.
	}
	return new Error(message);
}

export class SessionTransferClient {
	constructor(private readonly link: ParsedTransferLink) {}

	private attemptPath(attemptId: string, suffix = ""): string {
		return `${this.link.grantUrl}/attempts/${encodeURIComponent(attemptId)}${suffix}`;
	}

	private async request(url: string, init: RequestInit = {}): Promise<Response> {
		const target = new URL(url);
		if (
			target.origin !== this.link.origin ||
			!target.pathname.startsWith(
				`/api/session-transfers/${encodeURIComponent(this.link.instanceId)}/${encodeURIComponent(this.link.grantId)}`,
			)
		) {
			throw new Error(
				"Refusing to send the transfer token outside its exact origin and grant path",
			);
		}
		const response = await fetch(target, {
			...init,
			redirect: "manual",
			headers: { ...init.headers, Authorization: `Bearer ${this.link.token}` },
		});
		if (response.status >= 300 && response.status < 400)
			throw new Error("Transfer endpoint returned a redirect");
		return response;
	}

	private async requestOk(
		url: string,
		init: RequestInit = {},
		acceptedStatus?: number,
	): Promise<Response> {
		const response = await this.request(url, init);
		if (!response.ok && response.status !== acceptedStatus) throw await responseError(response);
		return response;
	}

	private async requestAttempt(url: string, init: RequestInit = {}) {
		const response = await this.requestOk(url, init);
		return ((await response.json()) as { attempt: RemoteTransferAttempt }).attempt;
	}

	async start(signal?: AbortSignal): Promise<RemoteTransferAttempt> {
		return this.requestAttempt(`${this.link.grantUrl}/attempts`, { method: "POST", signal });
	}

	async status(attemptId: string, signal?: AbortSignal): Promise<RemoteTransferAttempt> {
		return this.requestAttempt(this.attemptPath(attemptId), { signal });
	}

	async heartbeat(attemptId: string, signal?: AbortSignal): Promise<void> {
		await this.requestOk(this.attemptPath(attemptId, "/heartbeat"), {
			method: "POST",
			signal,
		});
	}

	async stream(attemptId: string, signal?: AbortSignal): Promise<Readable> {
		const response = await this.requestOk(this.attemptPath(attemptId, "/stream"), { signal });
		if (!response.body) throw new Error("Transfer endpoint returned no stream");
		return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
	}

	async cancel(attemptId: string): Promise<void> {
		await this.requestOk(
			this.attemptPath(attemptId),
			{ method: "DELETE", signal: AbortSignal.timeout(10_000) },
			404,
		);
	}

	async acknowledge(attemptId: string, signal?: AbortSignal): Promise<void> {
		await this.requestOk(this.attemptPath(attemptId, "/acknowledge"), {
			method: "POST",
			signal,
		});
	}
}
