import { statfsSync } from "node:fs";
import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type { DevelopmentToolsStartConfig } from "@leitwerk-dev/worker-protocol";
import { execa } from "execa";

export const PINNED_MISE_VERSION = "2026.8.14";
const OUTPUT_LIMIT_BYTES = 64 * 1024;
const JSON_LIMIT_BYTES = 1024 * 1024;
const TRACE_CHUNK_LENGTH = 16 * 1024;

export interface ToolPreparationRepository {
	repositoryKey: string;
	workingDirectory: string;
}

export interface ToolPreparationInput {
	config: DevelopmentToolsStartConfig;
	repositories: readonly ToolPreparationRepository[];
	signal?: AbortSignal;
	onProgress?(repositoryKey: string, phase: "installing" | "verifying"): void;
	onDiagnosticTrace?(text: string): void;
}

export interface PreparedToolEnvironment {
	miseVersion: string;
	commandEnvironment: NodeJS.ProcessEnv;
	repositories: Array<{
		repositoryKey: string;
		workingDirectory: string;
		tools: Array<{ name: string; version: string }>;
	}>;
	warnings: string[];
}

export interface DevelopmentToolEnvironment {
	prepare(input: ToolPreparationInput): Promise<PreparedToolEnvironment>;
}

export class DevelopmentToolPreparationError extends Error {
	constructor(
		message: string,
		readonly code:
			| "mise_missing"
			| "mise_unsupported"
			| "install_failed"
			| "verification_failed"
			| "timeout"
			| "cancelled",
		readonly diagnostics = "",
	) {
		super(message);
		this.name = "DevelopmentToolPreparationError";
	}
}

function parseVersion(value: string): [number, number, number] | null {
	const match = /(?:^|\s)(\d{4})\.(\d+)\.(\d+)(?:\s|$)/.exec(value);
	return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function compareVersion(a: readonly number[], b: readonly number[]): number {
	for (let index = 0; index < 3; index++) {
		const difference = (a[index] ?? 0) - (b[index] ?? 0);
		if (difference !== 0) return difference;
	}
	return 0;
}

export function validateMiseVersion(value: string, runner: "local" | "isolated"): string {
	const parsed = parseVersion(value);
	const pinned = parseVersion(PINNED_MISE_VERSION);
	if (!parsed || !pinned) {
		throw new DevelopmentToolPreparationError(
			`Could not determine mise version from '${value.trim()}'`,
			"mise_unsupported",
		);
	}
	if (
		(runner === "isolated" && compareVersion(parsed, pinned) !== 0) ||
		(runner === "local" && (parsed[0] !== pinned[0] || compareVersion(parsed, pinned) < 0))
	) {
		throw new DevelopmentToolPreparationError(
			`mise ${parsed.join(".")} is unsupported; expected ${runner === "isolated" ? PINNED_MISE_VERSION : `${PINNED_MISE_VERSION} or newer before ${pinned[0] + 1}.0.0`}`,
			"mise_unsupported",
		);
	}
	return parsed.join(".");
}

const SAFE_ENV_KEYS = new Set([
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"PATH",
	"TMPDIR",
	"TMP",
	"TEMP",
	"LANG",
	"TERM",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"ALL_PROXY",
	"NO_PROXY",
	"http_proxy",
	"https_proxy",
	"all_proxy",
	"no_proxy",
	"SSL_CERT_FILE",
	"SSL_CERT_DIR",
	"NODE_EXTRA_CA_CERTS",
	"XDG_CONFIG_HOME",
	"XDG_DATA_HOME",
	"XDG_CACHE_HOME",
	"XDG_STATE_HOME",
]);

/** Keep OS, network, and mise discovery settings while excluding application credentials. */
export function buildMiseSubprocessEnvironment(
	base: NodeJS.ProcessEnv,
	config: DevelopmentToolsStartConfig,
): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = {};
	for (const [key, value] of Object.entries(base)) {
		const safeMiseSetting =
			config.runner === "local" &&
			key.startsWith("MISE_") &&
			!/(?:TOKEN|PASSWORD|SECRET|AUTH|CREDENTIAL|API_KEY)/i.test(key);
		if (
			value !== undefined &&
			(SAFE_ENV_KEYS.has(key) || key.startsWith("LC_") || safeMiseSetting)
		) {
			env[key] = value;
		}
	}
	if (config.runner === "isolated") {
		const miseRoot = path.join(config.processStorageRoot, "tooling", "mise");
		env.MISE_DATA_DIR = miseRoot;
		env.MISE_INSTALLS_DIR = path.join(miseRoot, "installs");
		env.MISE_CACHE_DIR = path.join(miseRoot, "cache");
		env.MISE_STATE_DIR = path.join(miseRoot, "state");
	}
	return env;
}

function localShimDirectory(env: NodeJS.ProcessEnv): string {
	if (env.MISE_DATA_DIR) return path.join(env.MISE_DATA_DIR, "shims");
	if (env.XDG_DATA_HOME) return path.join(env.XDG_DATA_HOME, "mise", "shims");
	return path.join(env.HOME ?? "", ".local", "share", "mise", "shims");
}

function emitDiagnosticTrace(trace: ((text: string) => void) | undefined, value: string): void {
	if (!trace) return;
	for (let offset = 0; offset < value.length; offset += TRACE_CHUNK_LENGTH) {
		trace(value.slice(offset, offset + TRACE_CHUNK_LENGTH));
	}
}

function appendBounded(current: string, chunk: Buffer, limit: number): string {
	const combined = current + chunk.toString("utf8");
	return Buffer.byteLength(combined) <= limit
		? combined
		: Buffer.from(combined).subarray(-limit).toString("utf8");
}

async function runCommand(input: {
	command: string;
	args: string[];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs: number;
	signal?: AbortSignal;
	outputLimit?: number;
	onDiagnosticTrace?(text: string): void;
}): Promise<{ stdout: string; stderr: string }> {
	if (input.signal?.aborted) {
		throw new DevelopmentToolPreparationError("mise preparation was cancelled", "cancelled");
	}

	const child = execa(input.command, input.args, {
		cwd: input.cwd,
		env: input.env,
		stdin: "ignore",
		detached: true,
		timeout: input.timeoutMs,
		cancelSignal: input.signal,
		forceKillAfterDelay: 2_000,
		reject: false,
		stripFinalNewline: false,
	});
	let stdout = "";
	let stderr = "";
	const outputLimit = input.outputLimit ?? OUTPUT_LIMIT_BYTES;
	const appendOutput = (target: "stdout" | "stderr", chunk: Buffer | string) => {
		const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		const text = buffer.toString("utf8");
		emitDiagnosticTrace(input.onDiagnosticTrace, text);
		if (target === "stdout") stdout = appendBounded(stdout, buffer, outputLimit);
		else stderr = appendBounded(stderr, buffer, outputLimit);
	};
	child.stdout?.on("data", (chunk: Buffer | string) => appendOutput("stdout", chunk));
	child.stderr?.on("data", (chunk: Buffer | string) => appendOutput("stderr", chunk));

	// mise can create child processes; terminate the detached process group when
	// cancellation is requested, while execa owns timeout and escalation.
	let groupEscalation: ReturnType<typeof setTimeout> | null = null;
	const killGroup = () => {
		if (!child.pid) return;
		try {
			process.kill(-child.pid, "SIGTERM");
		} catch {
			child.kill("SIGTERM");
		}
		if (!groupEscalation) {
			const pid = child.pid;
			if (!pid) return;
			groupEscalation = setTimeout(() => {
				try {
					process.kill(-pid, "SIGKILL");
				} catch {
					/* execa will force-kill the child itself. */
				}
			}, 2_000);
			groupEscalation.unref();
		}
	};
	const groupTimeout = setTimeout(killGroup, input.timeoutMs);
	input.signal?.addEventListener("abort", killGroup, { once: true });
	try {
		const result = await child;
		const diagnostics = `${stdout}\n${stderr}`.trim();
		if (input.signal?.aborted || result.isCanceled) {
			throw new DevelopmentToolPreparationError(
				"mise preparation was cancelled",
				"cancelled",
				diagnostics,
			);
		}
		if (result.timedOut) {
			throw new DevelopmentToolPreparationError(
				`mise exceeded its ${input.timeoutMs}ms deadline`,
				"timeout",
				diagnostics,
			);
		}
		if (result.code === "ENOENT") {
			throw new DevelopmentToolPreparationError(
				`mise command '${input.command}' was not found`,
				"mise_missing",
				diagnostics,
			);
		}
		if (result.failed) {
			throw new Error(`${result.shortMessage}\n${diagnostics}`);
		}
		return { stdout, stderr };
	} finally {
		clearTimeout(groupTimeout);
		if (groupEscalation) clearTimeout(groupEscalation);
		input.signal?.removeEventListener("abort", killGroup);
	}
}

function toolPair(
	candidate: unknown,
	fallbackName?: string,
): { name: string; version: string } | null {
	if (!candidate || typeof candidate !== "object") return null;
	const item = candidate as Record<string, unknown>;
	const name = [item.tool, item.name, item.plugin, fallbackName].find(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);
	const version = [item.version, item.installed_version, item.requested_version].find(
		(value): value is string => typeof value === "string" && value.trim() !== "",
	);
	return name && version ? { name, version } : null;
}

/** Normalize the mise JSON adapter boundary without retaining backend-specific fields. */
export function normalizeMiseEvidence(value: unknown): Array<{ name: string; version: string }> {
	const tools: Array<{ name: string; version: string }> = [];
	if (Array.isArray(value)) {
		for (const item of value) {
			const pair = toolPair(item);
			if (pair) tools.push(pair);
		}
	} else if (value && typeof value === "object") {
		for (const [name, item] of Object.entries(value as Record<string, unknown>)) {
			for (const candidate of Array.isArray(item) ? item : [item]) {
				const pair =
					typeof candidate === "string" ? { name, version: candidate } : toolPair(candidate, name);
				if (pair) tools.push(pair);
			}
		}
	}
	return [...new Map(tools.map((tool) => [`${tool.name}\0${tool.version}`, tool])).values()].sort(
		(a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version),
	);
}

function availableSpace(root: string): string | null {
	try {
		const stats = statfsSync(root);
		return `${Number(stats.bavail) * Number(stats.bsize)} bytes available`;
	} catch {
		return null;
	}
}

function translateCommandError(
	error: unknown,
	input: {
		operation: "install" | "verification";
		failureMessage: string;
		repositoryKey: string;
		timeoutMs: number;
		root: string;
	},
): DevelopmentToolPreparationError {
	if (error instanceof DevelopmentToolPreparationError) {
		if (error.code !== "timeout") return error;
		return new DevelopmentToolPreparationError(
			`mise ${input.operation} timed out for repository '${input.repositoryKey}' after ${input.timeoutMs}ms`,
			"timeout",
			error.diagnostics,
		);
	}
	const space = input.operation === "install" ? availableSpace(input.root) : null;
	return new DevelopmentToolPreparationError(
		`${input.failureMessage} '${input.repositoryKey}'${space ? ` (${space})` : ""}`,
		input.operation === "install" ? "install_failed" : "verification_failed",
		error instanceof Error ? error.message : String(error),
	);
}

export class MiseDevelopmentToolEnvironment implements DevelopmentToolEnvironment {
	constructor(private readonly baseEnv: NodeJS.ProcessEnv = process.env) {}

	async prepare(input: ToolPreparationInput): Promise<PreparedToolEnvironment> {
		const env = buildMiseSubprocessEnvironment(this.baseEnv, input.config);
		const versionResult = await runCommand({
			command: input.config.miseCommand,
			args: ["--version"],
			cwd: input.config.processStorageRoot,
			env,
			timeoutMs: Math.min(input.config.installTimeoutMs, 30_000),
			signal: input.signal,
			onDiagnosticTrace: input.onDiagnosticTrace,
		});
		const miseVersion = validateMiseVersion(
			versionResult.stdout || versionResult.stderr,
			input.config.runner,
		);
		if (input.config.runner === "isolated") {
			await Promise.all(
				[env.MISE_DATA_DIR, env.MISE_INSTALLS_DIR, env.MISE_CACHE_DIR, env.MISE_STATE_DIR]
					.filter((value): value is string => Boolean(value))
					.map((directory) => mkdir(directory, { recursive: true })),
			);
		}
		const shimDirectory =
			input.config.runner === "isolated"
				? path.join(env.MISE_DATA_DIR as string, "shims")
				: localShimDirectory({ ...this.baseEnv, ...env });
		env.PATH = [shimDirectory, env.PATH].filter(Boolean).join(path.delimiter);
		const repositories: PreparedToolEnvironment["repositories"] = [];
		const warnings: string[] = [];
		for (const repository of [...input.repositories].sort((a, b) =>
			a.repositoryKey.localeCompare(b.repositoryKey),
		)) {
			const repositoryStartedAt = Date.now();
			input.onProgress?.(repository.repositoryKey, "installing");
			try {
				const installed = await runCommand({
					command: input.config.miseCommand,
					args: ["install"],
					cwd: repository.workingDirectory,
					env,
					timeoutMs: input.config.installTimeoutMs,
					signal: input.signal,
					onDiagnosticTrace: input.onDiagnosticTrace,
				});
				if (installed.stderr.trim()) {
					warnings.push(`${repository.repositoryKey}: ${installed.stderr.trim()}`);
				}
			} catch (error) {
				throw translateCommandError(error, {
					operation: "install",
					failureMessage: "mise install failed for repository",
					repositoryKey: repository.repositoryKey,
					timeoutMs: input.config.installTimeoutMs,
					root: input.config.processStorageRoot,
				});
			}
			input.onProgress?.(repository.repositoryKey, "verifying");
			let current: { stdout: string; stderr: string };
			try {
				current = await runCommand({
					command: input.config.miseCommand,
					args: ["ls", "--current", "--json"],
					cwd: repository.workingDirectory,
					env,
					timeoutMs: Math.max(
						1,
						input.config.installTimeoutMs - (Date.now() - repositoryStartedAt),
					),
					signal: input.signal,
					outputLimit: JSON_LIMIT_BYTES,
					onDiagnosticTrace: input.onDiagnosticTrace,
				});
			} catch (error) {
				throw translateCommandError(error, {
					operation: "verification",
					failureMessage: "mise could not verify repository",
					repositoryKey: repository.repositoryKey,
					timeoutMs: input.config.installTimeoutMs,
					root: input.config.processStorageRoot,
				});
			}
			let parsed: unknown;
			try {
				parsed = JSON.parse(current.stdout);
			} catch {
				throw new DevelopmentToolPreparationError(
					`mise returned invalid current-tool evidence for repository '${repository.repositoryKey}'`,
					"verification_failed",
				);
			}
			if (current.stderr.trim()) {
				warnings.push(`${repository.repositoryKey}: ${current.stderr.trim()}`);
			}
			repositories.push({ ...repository, tools: normalizeMiseEvidence(parsed) });
		}
		const commandEnvironment = {
			...this.baseEnv,
			...Object.fromEntries(Object.entries(env).filter(([key]) => key.startsWith("MISE_"))),
			PATH: [shimDirectory, this.baseEnv.PATH].filter(Boolean).join(path.delimiter),
		};
		const evidenceDir = path.join(input.config.processStorageRoot, "tooling", "mise-preparation");
		await mkdir(evidenceDir, { recursive: true });
		const evidence = {
			schemaVersion: 1,
			preparedAt: new Date().toISOString(),
			miseVersion,
			repositories,
		};
		const temporary = path.join(evidenceDir, `.latest-${process.pid}.json`);
		await writeFile(temporary, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
		await rename(temporary, path.join(evidenceDir, "latest.json"));
		return { miseVersion, commandEnvironment, repositories, warnings };
	}
}
