/** @internal */
export type PreparationRequest = <T>(input: {
	/** @internal */ method: string;
	/** @internal */ path: string;
	/** @internal */ body?: unknown;
	/** @internal */ contentType?: string;
	/** @internal */ ok?: readonly number[];
	/** @internal */ signal?: AbortSignal;
}) => Promise<{
	/** @internal */ status: number;
	/** @internal */ body: T | null;
}>;

/** Bounded transport for the server-owned preparation resources. @internal */
export function createPreparationApi(transport: PreparationRequest, component: string) {
	const request: PreparationRequest = <T>(input: Parameters<PreparationRequest>[0]) =>
		transport<T>({
			...input,
			signal: input.signal
				? AbortSignal.any([input.signal, AbortSignal.timeout(10_000)])
				: undefined,
		});
	return {
		/** @internal */
		request,
		/** @internal */
		async list<T>(path: string, selector: string, signal: AbortSignal): Promise<T[]> {
			const items: T[] = [];
			let cursor = "";
			do {
				const query = new URLSearchParams({ labelSelector: selector, limit: "100" });
				if (cursor) query.set("continue", cursor);
				const response = await request<{
					/** @internal */ items: T[];
					/** @internal */ metadata?: {
						/** @internal */ continue?: string;
					};
				}>({ method: "GET", path: `${path}?${query}`, signal });
				if (!response.body) throw new Error(`Missing ${component} list response`);
				items.push(...response.body.items);
				cursor = response.body.metadata?.continue ?? "";
			} while (cursor);
			return items;
		},
		/** @internal */
		async get<T>(path: string, signal: AbortSignal): Promise<T | null> {
			const response = await request<T>({ method: "GET", path, ok: [200, 404], signal });
			return response.status === 404 ? null : response.body;
		},
		/** @internal */
		async create(path: string, body: unknown, signal: AbortSignal): Promise<void> {
			await request({ method: "POST", path, body, ok: [201, 409], signal });
		},
		/** @internal */
		async delete(
			path: string,
			uid: string | undefined,
			signal: AbortSignal,
			identity: string,
			gracePeriodSeconds?: number,
		): Promise<void> {
			if (!uid) throw new Error(`${identity} identity is missing`);
			await request({
				method: "DELETE",
				path,
				body: {
					apiVersion: "v1",
					kind: "DeleteOptions",
					preconditions: { uid },
					...(gracePeriodSeconds === undefined ? {} : { gracePeriodSeconds }),
				},
				ok: [200, 202, 404],
				signal,
			});
		},
	};
}
