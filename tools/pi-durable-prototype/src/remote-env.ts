// biome-ignore-all lint/style/noNonNullAssertion: This throwaway fixture requires identities established by preceding operations and assertions.
import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from "node:child_process";
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Context } from "@earendil-works/chord";
import type {
	ExecutionEnv,
	ExecutionError,
	FileError,
	Result,
	ShellExecOptions,
	ShellExecResult,
	TextLine,
	TextLineReader,
} from "@earendil-works/pi-durable/env";
import type { SecretBoundary } from "./secrets.ts";

const IMAGE = "leitwerk-pi-durable-prototype:1.0.2";
/** Only the host-side Docker broker uses these variables; none are passed into the container. */
function dockerEnvironment(): NodeJS.ProcessEnv {
	return Object.fromEntries(
		["PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT"].flatMap((key) =>
			process.env[key] ? [[key, process.env[key]]] : [],
		),
	);
}
function encode(_key: string, value: unknown): unknown {
	return value instanceof Uint8Array ? { $bytes: Buffer.from(value).toString("base64") } : value;
}
function decode(_key: string, value: unknown): unknown {
	return value && typeof value === "object" && "$bytes" in value
		? Uint8Array.from(Buffer.from(String(value.$bytes), "base64"))
		: value;
}
interface Pending {
	resolve(value: unknown): void;
	reject(error: Error): void;
	output?: (text: string) => void;
}
/** Container transport. A lease check fences every operation and every returned result. @internal */
export class RemoteWorker {
	private readonly pending = new Map<number, Pending>();
	private nextId = 0;
	private process!: ChildProcessWithoutNullStreams;
	private closed = false;
	constructor(
		readonly options: {
			name: string;
			workspace: string;
			auditFile: string;
			boundary: SecretBoundary;
			authorize(): void;
		},
	) {}
	async start(): Promise<void> {
		// A crashed predecessor must be gone before this process can issue commands.
		this.removeOwnedContainer();
		const args = [
			"run",
			"--rm",
			"-i",
			"--name",
			this.options.name,
			"--label",
			"leitwerk.prototype=pi-durable",
			"--network",
			"none",
			"--read-only",
			"--cap-drop",
			"ALL",
			"--security-opt",
			"no-new-privileges",
			"--pids-limit",
			"96",
			"--memory",
			"512m",
			"--user",
			"65534:65534",
			"--tmpfs",
			"/tmp:rw,nosuid,nodev,size=64m",
			"--mount",
			`type=bind,src=${this.options.workspace},dst=/workspace`,
			IMAGE,
		];
		this.process = spawn("docker", args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: dockerEnvironment(),
		});
		await new Promise<void>((resolve, reject) => {
			let ready = false;
			let stderr = "";
			const timer = setTimeout(() => reject(new Error("Worker startup timed out")), 30_000);
			this.process.stderr.on("data", (data) => {
				stderr += String(data);
			});
			this.process.on("error", reject);
			this.process.on("exit", () => {
				clearTimeout(timer);
				for (const item of this.pending.values()) item.reject(new Error("Worker exited"));
				this.pending.clear();
				if (!ready) reject(new Error(`Worker failed to start: ${stderr.slice(-1200)}`));
			});
			createInterface({ input: this.process.stdout }).on("line", (line) => {
				const message = JSON.parse(line, decode);
				if (message.ready) {
					ready = true;
					clearTimeout(timer);
					resolve();
					return;
				}
				const pending = this.pending.get(message.id);
				if (!pending) return;
				try {
					this.options.authorize();
					this.options.boundary.assertPublic(message);
					appendFileSync(
						this.options.auditFile,
						`${JSON.stringify({ direction: "from_worker", message })}\n`,
					);
					if (message.output !== undefined) {
						pending.output?.(message.output);
						return;
					}
					if (message.error) pending.reject(new Error(message.error));
					else pending.resolve(message.result);
				} catch (error) {
					pending.reject(error as Error);
				}
				this.pending.delete(message.id);
			});
		});
	}
	async call<T>(
		method: string,
		args: unknown[],
		context: Context,
		output?: (text: string) => void,
	): Promise<T> {
		this.options.authorize();
		if (this.closed) throw new Error("Worker is closed");
		const id = ++this.nextId;
		const message = { id, method, args };
		const encoded = JSON.stringify(message, encode);
		this.options.boundary.assertPublic(message);
		appendFileSync(
			this.options.auditFile,
			`${JSON.stringify({ direction: "to_worker", message })}\n`,
		);
		const signal = context.abortSignal;
		signal?.throwIfAborted();
		const cancel = () =>
			this.process.stdin.write(`${JSON.stringify({ method: "cancel", target: id })}\n`);
		try {
			return await new Promise<T>((resolve, reject) => {
				this.pending.set(id, { resolve: (value) => resolve(value as T), reject, output });
				signal?.addEventListener("abort", cancel, { once: true });
				this.process.stdin.write(`${encoded}\n`);
			});
		} finally {
			signal?.removeEventListener("abort", cancel);
		}
	}
	async close(): Promise<void> {
		this.closed = true;
		this.process?.stdin.end();
		this.removeOwnedContainer();
	}
	private removeOwnedContainer(): void {
		const ids = execFileSync(
			"docker",
			[
				"ps",
				"-aq",
				"--filter",
				`name=^/${this.options.name}$`,
				"--filter",
				"label=leitwerk.prototype=pi-durable",
			],
			{ encoding: "utf8", env: dockerEnvironment() },
		)
			.trim()
			.split(/\s+/)
			.filter(Boolean);
		if (ids.length)
			execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore", env: dockerEnvironment() });
	}

	inspect(): unknown {
		return JSON.parse(
			execFileSync("docker", ["inspect", this.options.name], {
				encoding: "utf8",
				env: dockerEnvironment(),
			}),
		)[0];
	}
}

/** All environment operations execute remotely. No method falls back to the server filesystem. @internal */
export function remoteEnvironment(
	worker: RemoteWorker,
	authorize: () => void = () => {},
): ExecutionEnv {
	const call = async <T>(method: string, args: unknown[], context: Context): Promise<T> => {
		authorize();
		const value = await worker.call<T>(method, args, context);
		authorize();
		return value;
	};
	const environment: ExecutionEnv = {
		id: worker.options.name,
		cwd: "/workspace/repo",
		absolutePath: (path, ctx) => call("absolutePath", [path], ctx),
		joinPath: (parts, ctx) => call("joinPath", [parts], ctx),
		readTextFile: (path, ctx) => call("readTextFile", [path], ctx),
		readTextLines: (path, opts, ctx) => call("readTextLines", [path, opts], ctx),
		readBinaryFile: (path, ctx) => call("readBinaryFile", [path], ctx),
		writeFile: (path, data, ctx) => call("writeFile", [path, data], ctx),
		appendFile: (path, data, ctx) => call("appendFile", [path, data], ctx),
		truncateFile: (path, size, ctx) => call("truncateFile", [path, size], ctx),
		flushFile: (path, ctx) => call("flushFile", [path], ctx),
		renameFile: (from, to, ctx) => call("renameFile", [from, to], ctx),
		fileInfo: (path, ctx) => call("fileInfo", [path], ctx),
		listDir: (path, ctx) => call("listDir", [path], ctx),
		canonicalPath: (path, ctx) => call("canonicalPath", [path], ctx),
		exists: (path, ctx) => call("exists", [path], ctx),
		createDir: (path, opts, ctx) => call("createDir", [path, opts], ctx),
		remove: (path, opts, ctx) => call("remove", [path, opts], ctx),
		createTempDir: (prefix, ctx) => call("createTempDir", [prefix], ctx),
		createTempFile: (opts, ctx) => call("createTempFile", [opts], ctx),
		async openTextLineReader(path, ctx): Promise<Result<TextLineReader, FileError>> {
			const opened = await call<Result<number, FileError>>("openTextLineReader", [path], ctx);
			if (!opened.ok) return opened;
			return {
				ok: true,
				value: {
					readLine: (readContext) =>
						call<Result<TextLine | undefined, FileError>>(
							"reader.read",
							[opened.value],
							readContext,
						),
					close: (closeContext) => call<void>("reader.close", [opened.value], closeContext),
				},
			};
		},
		async exec(
			command,
			opts: ShellExecOptions = {},
			ctx,
		): Promise<Result<ShellExecResult, ExecutionError>> {
			authorize();
			if (opts.env !== undefined || opts.inheritEnv !== undefined)
				throw new Error("Shell environment overrides are forbidden");
			const { onOutput, ...wireOptions } = opts;
			const value = await worker.call<Result<ShellExecResult, ExecutionError>>(
				"exec",
				[command, wireOptions],
				ctx,
				(text) => {
					authorize();
					onOutput?.(text, ctx);
				},
			);
			authorize();
			return value;
		},
		async cleanup() {},
	};
	return environment;
}
