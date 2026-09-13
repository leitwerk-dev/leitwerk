import { copiedUnknownRecordSchema as unknownRecordSchema } from "@leitwerk-dev/domain";
import type { ErrorResponseBody } from "@leitwerk-dev/protocol/http-contracts";
import * as v from "valibot";
import { getFetchImpl, resolveApiUrl } from "./runtime-config.js";

export { unknownRecordSchema };

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

export function jsonRequestInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	};
}

type ResponseError = string | ((response: Response, body: unknown) => Error);

export async function requireSuccessfulResponse(
	response: Response,
	error?: ResponseError,
): Promise<void> {
	if (response.ok) return;
	const body = await tryReadJson(response);
	throw typeof error === "string"
		? new Error(readErrorMessage(body) ?? `${error}: ${response.status}`)
		: (error?.(response, body) ?? new Error(`Request failed: ${response.status}`));
}

export async function requestMutation(
	path: string,
	error: ResponseError,
	init: RequestInit,
): Promise<void> {
	await requireSuccessfulResponse(await getFetchImpl()(resolveApiUrl(path), init), error);
}

export async function requestJson<T extends object>(input: {
	path: string;
	init?: RequestInit;
	malformed: string;
	error?: ResponseError;
	onError?: (response: Response, body: unknown) => T | Promise<T>;
}): Promise<T> {
	const fetchImpl = getFetchImpl();
	const url = resolveApiUrl(input.path);
	const response = input.init ? await fetchImpl(url, input.init) : await fetchImpl(url);
	if (!response.ok && input.onError) return input.onError(response, await tryReadJson(response));
	await requireSuccessfulResponse(response, input.error);
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
