import { asUnknownRecord } from "@leitwerk-dev/domain";
import { IntegrationHttpClient } from "@leitwerk-dev/process-sdk";
import { boundedLogTail } from "./logs.js";

/** @internal */
export interface WoodpeckerProfile {
	/** @internal */
	baseUrl: string;
	/** @internal */
	token: string;
}
/** @public */
export interface WoodpeckerRepository {
	/** @public */
	id: number;
	/** @public */
	full_name: string;
}
/** @public */
export interface WoodpeckerPipeline {
	/** @internal */
	id: number;
	/** @internal */
	number: number;
	/** @internal */
	status: string;
	/** @internal */
	event: string;
	/** @internal */
	branch: string;
	/** @internal */
	commit: string;
	/** @internal */
	created_at?: number;
	/** @internal */
	workflows?: unknown[];
}

interface WoodpeckerLogEntry {
	data?: number[] | string;
}

function decodeLogData(data: WoodpeckerLogEntry["data"]): string {
	if (Array.isArray(data)) {
		return new TextDecoder("utf-8", { fatal: false }).decode(Uint8Array.from(data));
	}
	if (typeof data !== "string") return "";
	if (/^[A-Za-z0-9+/]*={0,2}$/.test(data) && data.length % 4 === 0) {
		try {
			const binary = atob(data);
			return new TextDecoder("utf-8", { fatal: false }).decode(
				Uint8Array.from(binary, (character) => character.charCodeAt(0)),
			);
		} catch {
			// Preserve an unexpected plain-text representation instead of hiding logs.
		}
	}
	return data;
}

/** @internal */
export function parseWoodpeckerProfiles(value: unknown): Map<string, WoodpeckerProfile> {
	const profiles = new Map<string, WoodpeckerProfile>();
	for (const [name, raw] of Object.entries(
		asUnknownRecord(asUnknownRecord(value)?.profiles) ?? {},
	)) {
		const config = asUnknownRecord(raw) ?? {};
		const baseUrl = typeof config.base_url === "string" ? config.base_url.replace(/\/+$/, "") : "";
		const token = typeof config.token === "string" ? config.token.trim() : "";
		if (!/^https:\/\//.test(baseUrl))
			throw new Error(`Woodpecker profile '${name}' requires an HTTPS base_url`);
		if (!token) throw new Error(`Woodpecker profile '${name}' requires a token`);
		profiles.set(name, { baseUrl, token });
	}
	return profiles;
}

/** @public */
export class WoodpeckerClient extends IntegrationHttpClient {
	/** @internal */
	constructor(
		/** @internal */
		readonly profile: WoodpeckerProfile,
	) {
		super("Woodpecker", `${profile.baseUrl}/api`, {
			Authorization: `Bearer ${profile.token}`,
			Accept: "application/json",
		});
	}

	/** @internal */
	lookupRepository(fullName: string, signal?: AbortSignal): Promise<WoodpeckerRepository> {
		return this.request(`/repos/lookup/${encodeURIComponent(fullName)}`, {
			signal,
		});
	}

	/** @internal */
	listPipelines(
		repoId: number,
		signal?: AbortSignal,
		pagination: {
			/** @internal */
			page: number;
			/** @internal */
			perPage?: number;
		} = { page: 1 },
	): Promise<WoodpeckerPipeline[]> {
		const { page, perPage = 100 } = pagination;
		if (
			!Number.isSafeInteger(page) ||
			page < 1 ||
			!Number.isSafeInteger(perPage) ||
			perPage < 1 ||
			perPage > 100
		)
			throw new Error("Invalid Woodpecker pipeline pagination");
		return this.request(`/repos/${repoId}/pipelines?page=${page}&perPage=${perPage}`, {
			signal,
		});
	}

	/** @internal */
	getPipeline(repoId: number, number: number, signal?: AbortSignal): Promise<WoodpeckerPipeline> {
		return this.request(`/repos/${repoId}/pipelines/${number}`, { signal });
	}

	/** @public */
	async getStepLogs(
		repoId: number,
		number: number,
		stepId: number,
		tailLines = 400,
		maxBytes = 262_144,
		signal?: AbortSignal,
	) {
		const body = await (
			await this.response(`/repos/${repoId}/logs/${number}/${stepId}`, {
				signal,
			})
		).text();
		let text = body;
		try {
			const entries = JSON.parse(body) as unknown;
			if (Array.isArray(entries)) {
				text = entries
					.map((entry) =>
						decodeLogData(asUnknownRecord(entry)?.data as WoodpeckerLogEntry["data"]).replace(
							/\r?\n$/,
							"",
						),
					)
					.join("\n");
			}
		} catch {
			// Older adapters may return text directly; retain it as-is.
		}
		const output = boundedLogTail(text.split(/\r?\n/), tailLines, maxBytes);
		return {
			/** @public */
			logs: output,
			/** @internal */
			truncated: output.length < text.length,
		};
	}

	/** @internal */
	restartPipeline(
		repoId: number,
		number: number,
		signal?: AbortSignal,
	): Promise<WoodpeckerPipeline> {
		return this.request(`/repos/${repoId}/pipelines/${number}`, {
			method: "POST",
			signal,
		});
	}
}
