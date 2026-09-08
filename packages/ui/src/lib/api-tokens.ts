import type {
	ApiTokensResponseBody,
	CreateApiTokenResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import { readErrorMessage, requestJson } from "./http-client.js";

function request<T extends object>(path: string, options: RequestInit = {}): Promise<T> {
	return requestJson({
		path,
		init: { ...options, credentials: "same-origin", cache: "no-store" },
		malformed: "Malformed API token response",
		error: (response, body) =>
			new Error(readErrorMessage(body) ?? `Request failed (${response.status})`),
	});
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
