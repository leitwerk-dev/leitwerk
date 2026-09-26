import type { ScopedSettingsSnapshot, SettingsContext } from "@leitwerk-dev/domain";
import type {
	SettingsPreview,
	SettingsScopesResponse,
} from "@leitwerk-dev/protocol/http-contracts";
import { jsonRequestInit, requestJson } from "./http-client.js";

/** @internal */
export class SettingsRequestError extends Error {
	constructor(
		message: string,
		readonly status: number,
	) {
		super(message);
	}
}

function settingsError(fallback: string) {
	return (response: Response, body: unknown) => {
		const payload = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
		// Fastify supplies a status title in error and the actionable detail in message.
		const detail = typeof payload?.message === "string" ? payload.message : payload?.error;
		return new SettingsRequestError(
			typeof detail === "string" ? detail : fallback,
			response.status,
		);
	};
}

export interface SettingsChange {
	subjectId: string;
	key: string;
	value: unknown;
	mode: "append" | "replace";
	reset: boolean;
	expectedRevision: number;
}

export function fetchSettingsScopes(refresh = false) {
	return requestJson<SettingsScopesResponse>({
		path: `/api/settings/scopes${refresh ? "/refresh" : ""}`,
		...(refresh ? { init: jsonRequestInit("POST", {}) } : {}),
		malformed: "Could not read settings scopes",
		error: settingsError("Could not load settings scopes"),
	});
}
export function fetchSettingsPreview(subjectId: string) {
	return requestJson<SettingsPreview>({
		path: `/api/settings/preview?subjectId=${encodeURIComponent(subjectId)}`,
		malformed: "Could not read settings",
		error: settingsError("Could not load settings"),
	});
}
export function changeSettings(change: SettingsChange, preview = false) {
	return requestJson<SettingsPreview>({
		path: `/api/settings/${preview ? "preview" : "overrides"}`,
		init: jsonRequestInit(preview ? "POST" : "PUT", change),
		malformed: "Could not read settings",
		error: settingsError(preview ? "Could not preview setting" : "Could not save setting"),
	});
}
export interface ProcessSettingsView {
	primaryRepositoryKey: string | null;
	future: Array<{ turnId: string; settings: ScopedSettingsSnapshot | null; error: string | null }>;
	context: SettingsContext;
	explanations: string[];
	repositories: Array<{ key: string; subjectId: string; label: string }>;
	next: ScopedSettingsSnapshot | null;
	error: string | null;
	captured: Array<{
		startRecordId: string;
		turnId: string;
		createdAt: string;
		state: string;
		settings: ScopedSettingsSnapshot;
	}>;
}
export function fetchProcessSettings(instanceId: string) {
	return requestJson<ProcessSettingsView>({
		path: `/api/settings/processes/${encodeURIComponent(instanceId)}`,
		malformed: "Could not read process settings",
		error: settingsError("Could not load process settings"),
	});
}

export function settingsPath(subjectId = "instance") {
	return `/settings?scope=${encodeURIComponent(subjectId)}`;
}

export function bindPrimaryRepository(
	instanceId: string,
	primaryRepositoryKey: string | null,
	expectedPrimaryRepositoryKey: string | null,
) {
	return requestJson<{ primaryRepositoryKey: string | null }>({
		path: `/api/settings/processes/${encodeURIComponent(instanceId)}/primary-repository`,
		init: jsonRequestInit("PUT", { primaryRepositoryKey, expectedPrimaryRepositoryKey }),
		malformed: "Could not read primary repository",
		error: settingsError("Could not bind primary repository"),
	});
}
