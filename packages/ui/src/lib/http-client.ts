import type { ErrorResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import * as v from "valibot";
import { getFetchImpl, resolveApiUrl } from "./runtime-config.js";

export const unknownRecordSchema = v.pipe(
	v.unknown(),
	v.check(
		(value) => typeof value === "object" && value !== null && !Array.isArray(value),
		"Expected object",
	),
	v.record(v.string(), v.unknown()),
);

export async function tryReadJson(response: Response): Promise<unknown> {
	try {
		return await response.json();
	} catch {
		return null;
	}
}

export async function readJsonObject<T extends object>(
	response: Response,
	context: string,
): Promise<T> {
	const body = await tryReadJson(response);
	if (!v.safeParse(unknownRecordSchema, body).success) {
		throw new Error(`${context}: response body must be a JSON object`);
	}
	return body as T;
}

export async function requestJson<T extends object>(input: {
	path: string;
	init?: RequestInit;
	malformed: string;
	error?: (response: Response, body: unknown) => Error;
	onError?: (response: Response, body: unknown) => T | Promise<T>;
}): Promise<T> {
	const fetchImpl = getFetchImpl();
	const url = resolveApiUrl(input.path);
	const response = input.init ? await fetchImpl(url, input.init) : await fetchImpl(url);
	if (!response.ok) {
		const body = await tryReadJson(response);
		if (input.onError) return input.onError(response, body);
		throw input.error?.(response, body) ?? new Error(`Request failed: ${response.status}`);
	}
	return readJsonObject<T>(response, input.malformed);
}

function readOptionalString(value: unknown): string | null {
	return typeof value === "string" ? value : null;
}

export function readErrorMessage(body: unknown): string | null {
	const response = body as (ErrorResponseBody & { message?: unknown }) | null;
	const error = readOptionalString(response?.error) ?? readOptionalString(response?.message);
	return error && error.trim() !== "" ? error : null;
}
