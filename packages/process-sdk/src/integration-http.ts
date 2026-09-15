/** Shared transport; extensions own endpoint paths, credentials, and response types. */
export class IntegrationHttpClient {
	constructor(
		private readonly provider: string,
		private readonly baseUrl: string,
		private readonly headers: Record<string, string>,
		private readonly pagination = { key: "per_page", size: 100 },
	) {}

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
			throw new Error(
				`${this.provider} ${init.method ?? "GET"} ${path} failed with ${response.status}`,
			);
		return response;
	}

	protected async request<T>(path: string, init: RequestInit = {}): Promise<T> {
		const response = await this.response(path, init);
		return response.status === 204 ? (undefined as T) : response.json();
	}

	protected writeJson<T>(path: string, method: string, body: unknown, signal?: AbortSignal) {
		return this.request<T>(path, { method, body: JSON.stringify(body), signal });
	}

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
