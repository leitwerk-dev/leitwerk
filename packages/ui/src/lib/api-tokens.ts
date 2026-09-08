import type {
	ApiTokensResponseBody,
	CreateApiTokenResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import { getFetchImpl, resolveApiUrl } from "./runtime-config.js";

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
	const response = await getFetchImpl()(resolveApiUrl(path), {
		...options,
		credentials: "same-origin",
		cache: "no-store",
	});
	const body = await response.json();
	if (!response.ok) throw new Error(body.error ?? `Request failed (${response.status})`);
	return body as T;
}
export function fetchApiTokens(): Promise<ApiTokensResponseBody> {
	return request("/api/auth/tokens");
}
export function createApiToken(
	csrfToken: string,
	input: { name: string; expiresAt?: string | null },
): Promise<CreateApiTokenResponseBody> {
	return request("/api/auth/tokens", {
		method: "POST",
		headers: { "content-type": "application/json", "x-csrf-token": csrfToken },
		body: JSON.stringify(input),
	});
}
export function revokeApiToken(csrfToken: string, id?: string): Promise<{ ok: boolean }> {
	return request(`/api/auth/tokens${id ? `/${encodeURIComponent(id)}` : ""}`, {
		method: "DELETE",
		headers: { "x-csrf-token": csrfToken },
	});
}
