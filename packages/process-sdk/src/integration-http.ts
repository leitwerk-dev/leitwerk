/** An HTTP failure without provider response bodies or credentials. @public */
export class IntegrationHttpError extends Error {
	/** @public */
	constructor(
		/** @public */
		readonly status: number,
		message: string,
	) {
		super(message);
	}
}

/** Shared transport; extensions own endpoint paths, credentials, and response types. @public */
export class IntegrationHttpClient {
	/** @internal */
	constructor(
		private readonly provider: string,
		private readonly baseUrl: string,
		private readonly headers: Record<string, string>,
		private readonly pagination = {
			/** @internal */
			key: "per_page",
			/** @internal */
			size: 100,
		},
	) {}

	/** @internal */
	protected async response(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${this.baseUrl}${path}`, {
			...init,
			headers: {
				...this.headers,
				...(init.body ? { "Content-Type": "application/json" } : {}),
				...init.headers,
			},
		});
		if (!response.ok)
			throw new IntegrationHttpError(
				response.status,
				`${this.provider} ${init.method ?? "GET"} ${path} failed with ${response.status}`,
			);
		return response;
	}

	/** @internal */
	protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.response(path, init);
		return response.status === 204 ? (undefined as T) : response.json();
	}

	/** @internal */
	protected writeJson<T>(path: string, method: string, body: unknown, signal?: AbortSignal) {
		return this.request<T>(path, { method, body: JSON.stringify(body), signal });
	}

	/** @internal */
	protected async pages<T>(path: string, signal?: AbortSignal): Promise<T[]> {
		const items: T[] = [];
		const { key, size } = this.pagination;
		for (let page = 1; ; page++) {
			const separator = path.includes("?") ? "&" : "?";
			const batch = await this.request<T[]>(`${path}${separator}${key}=${size}&page=${page}`, {
				signal,
			});
			items.push(...batch);
			if (batch.length < size) return items;
		}
	}
}
