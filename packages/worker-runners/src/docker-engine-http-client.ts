import http from "node:http";
import { text as readText } from "node:stream/consumers";
import type {
	DockerContainerExit,
	DockerContainerInspect,
	DockerContainerSpec,
	DockerEngineClient,
} from "./docker-engine-client.js";

export class DockerEngineHttpError extends Error {
	constructor(
		message: string,
		readonly statusCode: number,
		readonly body: string,
	) {
		super(message);
	}
}

export function isDockerEngineNotFoundError(error: unknown): boolean {
	return error instanceof DockerEngineHttpError && error.statusCode === 404;
}

export interface ParsedDockerEngineSocket {
	socketPath?: string;
	baseUrl?: URL;
}

export function parseDockerEngineSocket(value: string): ParsedDockerEngineSocket {
	if (value.startsWith("unix://")) {
		const socketPath = value.slice("unix://".length);
		if (!socketPath.startsWith("/"))
			throw new Error("docker.socket unix:// URL must contain an absolute path");
		return { socketPath };
	}
	if (value.startsWith("http://")) return { baseUrl: new URL(value) };
	if (value.startsWith("https://")) {
		throw new Error(
			"docker.socket https:// is not supported by the built-in Docker adapter; use unix:// or http://",
		);
	}
	if (value.startsWith("/")) return { socketPath: value };
	throw new Error(
		`Unsupported docker.socket value '${value}'; expected unix:///path/to/docker.sock`,
	);
}

export interface DockerEngineHttpClientOptions {
	socket: string;
	apiVersion?: string;
}

interface DockerApiRequest {
	method: "GET" | "POST" | "DELETE";
	path: string;
	query?: Record<string, string>;
	body?: unknown;
}

function encodeQuery(query?: Record<string, string>): string {
	if (!query) return "";
	const params = new URLSearchParams(query);
	const text = params.toString();
	return text ? `?${text}` : "";
}

function toMounts(spec: DockerContainerSpec): Array<Record<string, unknown>> {
	return spec.mounts.map((mount) => ({
		Type: mount.source.startsWith("/") ? "bind" : "volume",
		Source: mount.source,
		Target: mount.target,
		ReadOnly: mount.readOnly ?? false,
		...(mount.volumeSubpath !== undefined
			? { VolumeOptions: { Subpath: mount.volumeSubpath, NoCopy: true } }
			: {}),
	}));
}

function requireVolumeSubpathApiVersion(value: unknown): string {
	if (typeof value === "string" && /^\d+\.\d+$/.test(value)) {
		const [major = 0, minor = 0] = value.split(".").map(Number);
		if (major > 1 || (major === 1 && minor >= 45)) return value;
	}
	throw new Error("Scoped Docker volume mounts require Docker Engine 26.0 or newer (API 1.45+)");
}

function toContainerCreateBody(spec: DockerContainerSpec): Record<string, unknown> {
	return {
		Image: spec.image,
		Env: spec.env,
		Labels: spec.labels,
		...(spec.command ? { Cmd: spec.command } : {}),
		HostConfig: {
			Mounts: toMounts(spec),
			NetworkMode: spec.networkMode,
			Privileged: spec.privileged,
			...(spec.runtime ? { Runtime: spec.runtime } : {}),
			...(spec.nanoCpus ? { NanoCpus: spec.nanoCpus } : {}),
			...(spec.memoryBytes ? { Memory: spec.memoryBytes } : {}),
		},
	};
}

interface DockerInspectResponse {
	Id: string;
	State?: { Running?: boolean };
	Config?: { Labels?: Record<string, string> };
}

interface DockerWaitResponse {
	StatusCode?: number;
	Error?: { Message?: string };
}

interface DockerCreateResponse {
	Id: string;
}

interface DockerListContainerResponse {
	Id: string;
	Labels?: Record<string, string>;
}

function mapInspect(raw: DockerInspectResponse): DockerContainerInspect {
	return {
		id: raw.Id,
		running: raw.State?.Running === true,
		labels: raw.Config?.Labels ?? {},
	};
}

function mapWait(raw: DockerWaitResponse): DockerContainerExit {
	return {
		statusCode: Number(raw.StatusCode ?? 0),
		...(raw.Error?.Message ? { error: raw.Error.Message } : {}),
	};
}

export function createDockerEngineHttpClient(
	options: DockerEngineHttpClientOptions,
): DockerEngineClient {
	const endpoint = parseDockerEngineSocket(options.socket);
	const configuredApiVersion = options.apiVersion?.replace(/^v/, "");
	async function request<T>(
		apiReq: DockerApiRequest,
		apiVersion = configuredApiVersion,
	): Promise<T> {
		const prefix = apiVersion ? `/v${apiVersion}` : "";
		const path = `${prefix}${apiReq.path}${encodeQuery(apiReq.query)}`;
		const body = apiReq.body === undefined ? undefined : JSON.stringify(apiReq.body);
		const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
			const req = http.request(
				{
					method: apiReq.method,
					path: endpoint.baseUrl ? `${endpoint.baseUrl.pathname.replace(/\/$/, "")}${path}` : path,
					socketPath: endpoint.socketPath,
					hostname: endpoint.baseUrl?.hostname,
					port: endpoint.baseUrl?.port,
					headers: body
						? { "content-type": "application/json", "content-length": Buffer.byteLength(body) }
						: undefined,
				},
				resolve,
			);
			req.on("error", reject);
			req.end(body);
		});
		const text = await readText(response);
		if ((response.statusCode ?? 500) >= 400) {
			throw new DockerEngineHttpError(
				`Docker Engine ${apiReq.method} ${apiReq.path} failed with ${response.statusCode}: ${text}`,
				response.statusCode ?? 500,
				text,
			);
		}
		return (text ? JSON.parse(text) : undefined) as T;
	}
	return {
		async createContainer(spec) {
			let apiVersion = configuredApiVersion;
			if (spec.mounts.some((mount) => mount.volumeSubpath !== undefined)) {
				const version =
					configuredApiVersion ??
					(await request<{ ApiVersion?: string }>({ method: "GET", path: "/version" })).ApiVersion;
				// Pin this request to an API that understands Subpath. An older daemon
				// must reject the request, never ignore the option and mount the volume root.
				apiVersion = requireVolumeSubpathApiVersion(version);
			}
			const raw = await request<DockerCreateResponse>(
				{
					method: "POST",
					path: "/containers/create",
					query: { name: spec.name },
					body: toContainerCreateBody(spec),
				},
				apiVersion,
			);
			return { id: raw.Id };
		},
		async startContainer(id) {
			await request({ method: "POST", path: `/containers/${encodeURIComponent(id)}/start` });
		},
		async stopContainer(id, opts) {
			await request({
				method: "POST",
				path: `/containers/${encodeURIComponent(id)}/stop`,
				query: { t: String(opts.timeoutSeconds) },
			});
		},
		async removeContainer(id, opts) {
			await request({
				method: "DELETE",
				path: `/containers/${encodeURIComponent(id)}`,
				query: { force: opts.force ? "1" : "0", v: "1" },
			});
		},
		async inspectContainer(id) {
			return mapInspect(
				await request<DockerInspectResponse>({
					method: "GET",
					path: `/containers/${encodeURIComponent(id)}/json`,
				}),
			);
		},
		async listContainers(filter) {
			const raw = await request<DockerListContainerResponse[]>({
				method: "GET",
				path: "/containers/json",
				query: {
					filters: JSON.stringify({
						label: Object.entries(filter.labels).map(([key, value]) => `${key}=${value}`),
					}),
				},
			});
			return raw.map((c) => ({ id: c.Id, labels: c.Labels ?? {} }));
		},
		async waitContainer(id) {
			return mapWait(
				await request<DockerWaitResponse>({
					method: "POST",
					path: `/containers/${encodeURIComponent(id)}/wait`,
				}),
			);
		},
		async ensureVolume(name) {
			await request({ method: "POST", path: "/volumes/create", body: { Name: name } });
		},
		async removeVolume(name) {
			try {
				await request({ method: "DELETE", path: `/volumes/${encodeURIComponent(name)}` });
			} catch (error) {
				if (!isDockerEngineNotFoundError(error)) throw error;
			}
		},
	};
}
