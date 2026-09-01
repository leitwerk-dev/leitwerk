import http from "node:http";
import type {
	DockerContainerExit,
	DockerContainerInspect,
	DockerContainerSpec,
	DockerEngineClient,
	DockerListContainersFilter,
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

function dockerPathComponent(value: string): string {
	return encodeURIComponent(value).replaceAll("%2F", "%2F");
}

function toMounts(spec: DockerContainerSpec): Array<Record<string, unknown>> {
	return spec.mounts.map((mount) => ({
		Type: mount.source.startsWith("/") ? "bind" : "volume",
		Source: mount.source,
		Target: mount.target,
		ReadOnly: mount.readOnly ?? false,
	}));
}

function toContainerCreateBody(spec: DockerContainerSpec): Record<string, unknown> {
	const volumes: Record<string, Record<string, never>> = {};
	for (const target of spec.anonymousVolumes ?? []) volumes[target] = {};
	return {
		Image: spec.image,
		Env: spec.env,
		Labels: spec.labels,
		...(spec.command ? { Cmd: spec.command } : {}),
		Volumes: volumes,
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

export function dockerEngineRequestMapping(
	method: keyof DockerEngineClient,
	args: unknown[],
): DockerApiRequest {
	switch (method) {
		case "createContainer": {
			const spec = args[0] as DockerContainerSpec;
			return {
				method: "POST",
				path: "/containers/create",
				query: { name: spec.name },
				body: toContainerCreateBody(spec),
			};
		}
		case "startContainer":
			return {
				method: "POST",
				path: `/containers/${dockerPathComponent(args[0] as string)}/start`,
			};
		case "stopContainer":
			return {
				method: "POST",
				path: `/containers/${dockerPathComponent(args[0] as string)}/stop`,
				query: { t: String((args[1] as { timeoutSeconds: number }).timeoutSeconds) },
			};
		case "removeContainer":
			return {
				method: "DELETE",
				path: `/containers/${dockerPathComponent(args[0] as string)}`,
				query: { force: (args[1] as { force?: boolean }).force ? "1" : "0", v: "1" },
			};
		case "inspectContainer":
			return { method: "GET", path: `/containers/${dockerPathComponent(args[0] as string)}/json` };
		case "listContainers": {
			const filter = args[0] as DockerListContainersFilter;
			return {
				method: "GET",
				path: "/containers/json",
				query: {
					filters: JSON.stringify({
						label: Object.entries(filter.labels).map(([k, v]) => `${k}=${v}`),
					}),
				},
			};
		}
		case "waitContainer":
			return { method: "POST", path: `/containers/${dockerPathComponent(args[0] as string)}/wait` };
		case "ensureVolume":
			return { method: "POST", path: "/volumes/create", body: { Name: args[0] } };
		case "removeVolume":
			return { method: "DELETE", path: `/volumes/${dockerPathComponent(args[0] as string)}` };
		default:
			throw new Error(`No Docker Engine HTTP mapping for ${String(method)}`);
	}
}

export function createDockerEngineHttpClient(
	options: DockerEngineHttpClientOptions,
): DockerEngineClient {
	const endpoint = parseDockerEngineSocket(options.socket);
	const prefix = options.apiVersion ? `/v${options.apiVersion.replace(/^v/, "")}` : "";
	async function request<T>(apiReq: DockerApiRequest): Promise<T> {
		const path = `${prefix}${apiReq.path}${encodeQuery(apiReq.query)}`;
		const body = apiReq.body === undefined ? undefined : JSON.stringify(apiReq.body);
		return new Promise<T>((resolve, reject) => {
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
				(res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
					res.on("end", () => {
						const text = Buffer.concat(chunks).toString("utf8");
						if ((res.statusCode ?? 500) >= 400)
							return reject(
								new DockerEngineHttpError(
									`Docker Engine ${apiReq.method} ${apiReq.path} failed with ${res.statusCode}: ${text}`,
									res.statusCode ?? 500,
									text,
								),
							);
						resolve((text ? JSON.parse(text) : undefined) as T);
					});
				},
			);
			req.on("error", reject);
			if (body) req.write(body);
			req.end();
		});
	}
	return {
		async createContainer(spec) {
			const raw = await request<DockerCreateResponse>(
				dockerEngineRequestMapping("createContainer", [spec]),
			);
			return { id: raw.Id };
		},
		async startContainer(id) {
			await request(dockerEngineRequestMapping("startContainer", [id]));
		},
		async stopContainer(id, opts) {
			await request(dockerEngineRequestMapping("stopContainer", [id, opts]));
		},
		async removeContainer(id, opts) {
			await request(dockerEngineRequestMapping("removeContainer", [id, opts]));
		},
		async inspectContainer(id) {
			return mapInspect(
				await request<DockerInspectResponse>(dockerEngineRequestMapping("inspectContainer", [id])),
			);
		},
		async listContainers(filter) {
			const raw = await request<DockerListContainerResponse[]>(
				dockerEngineRequestMapping("listContainers", [filter]),
			);
			return raw.map((c) => ({ id: c.Id, labels: c.Labels ?? {} }));
		},
		async waitContainer(id) {
			return mapWait(
				await request<DockerWaitResponse>(dockerEngineRequestMapping("waitContainer", [id])),
			);
		},
		async ensureVolume(name) {
			await request(dockerEngineRequestMapping("ensureVolume", [name]));
		},
		async removeVolume(name) {
			try {
				await request(dockerEngineRequestMapping("removeVolume", [name]));
			} catch (error) {
				if (!isDockerEngineNotFoundError(error)) throw error;
			}
		},
	};
}
