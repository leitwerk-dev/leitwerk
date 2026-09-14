import { asUnknownRecord } from "@leitwerk-dev/domain";
import { boundedLogTail } from "./logs.js";

export interface WoodpeckerProfile {
	baseUrl: string;
	token: string;
}
export interface WoodpeckerRepository {
	id: number;
	full_name: string;
}
export interface WoodpeckerPipeline {
	id: number;
	number: number;
	status: string;
	event: string;
	branch: string;
	commit: string;
	created_at?: number;
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

export class WoodpeckerClient {
	constructor(readonly profile: WoodpeckerProfile) {}

	private async response(path: string, init: RequestInit = {}): Promise<Response> {
		const response = await fetch(`${this.profile.baseUrl}/api${path}`, {
			...init,
			headers: {
				Authorization: `Bearer ${this.profile.token}`,
				Accept: "application/json",
				...init.headers,
			},
		});
		if (!response.ok)
			throw new Error(`Woodpecker ${init.method ?? "GET"} ${path} failed with ${response.status}`);
		return response;
	}

	private async json<T>(path: string, init: RequestInit = {}): Promise<T> {
		return (await (await this.response(path, init)).json()) as T;
	}

	lookupRepository(fullName: string, signal?: AbortSignal): Promise<WoodpeckerRepository> {
		return this.json(`/repos/lookup/${encodeURIComponent(fullName)}`, {
			signal,
		});
	}

	listPipelines(
		repoId: number,
		signal?: AbortSignal,
		pagination: { page: number; perPage?: number } = { page: 1 },
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
		return this.json(`/repos/${repoId}/pipelines?page=${page}&perPage=${perPage}`, {
			signal,
		});
	}

	getPipeline(repoId: number, number: number, signal?: AbortSignal): Promise<WoodpeckerPipeline> {
		return this.json(`/repos/${repoId}/pipelines/${number}`, { signal });
	}

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
		return { logs: output, truncated: output.length < text.length };
	}

	restartPipeline(
		repoId: number,
		number: number,
		signal?: AbortSignal,
	): Promise<WoodpeckerPipeline> {
		return this.json(`/repos/${repoId}/pipelines/${number}`, {
			method: "POST",
			signal,
		});
	}
}
