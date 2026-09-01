import type {
	CoreServerSetupDeps,
	ExternalActionSource,
	ExternalSourceArmingLike,
} from "@leitwerk-dev/process-sdk";
import {
	consumeTriggerFile,
	emptyPollResult,
	type PollResult,
	parseDurationMs,
	readTriggerFile,
} from "@leitwerk-dev/watcher-utils";

export type FileExternalConsumeMode = "delete" | "keep";

export interface FileExternalInput {
	path: string;
	pollInterval: string;
	consume: FileExternalConsumeMode;
}

export const FILE_EXTERNAL_PRESENCE_KIND = "@leitwerk-dev/showcase-processes.file.presence";
export const FILE_EXTERNAL_INSTRUCTION_KIND = "@leitwerk-dev/showcase-processes.file.instruction";

function normalizeConfig(input: FileExternalInput): FileExternalInput {
	return {
		path: input.path,
		pollInterval: input.pollInterval,
		consume: input.consume,
	};
}

function interpolateTemplate(template: string, values: Record<string, string>): string {
	return template.replace(/\{([a-zA-Z0-9_]+)\}/g, (match, key: string) => values[key] ?? match);
}

function resolveFileConfig(
	input: FileExternalInput,
	ctx: { process: { id: string } },
): FileExternalInput {
	return {
		...input,
		path: interpolateTemplate(input.path, { instanceId: ctx.process.id }),
	};
}

function fileLabel(kind: "presence" | "instruction", path: string): string {
	return kind === "presence" ? `File present: ${path}` : `File instruction: ${path}`;
}

export const fileExternal = {
	presence(input: FileExternalInput): ExternalActionSource {
		const config = normalizeConfig(input);
		return {
			kind: FILE_EXTERNAL_PRESENCE_KIND,
			label: fileLabel("presence", config.path),
			description: `Fires when ${config.path} exists`,
			config,
			inputMode: "none",
			resolve(ctx) {
				return resolveFileConfig(config, ctx);
			},
		};
	},
	instruction(input: FileExternalInput): ExternalActionSource {
		const config = normalizeConfig(input);
		return {
			kind: FILE_EXTERNAL_INSTRUCTION_KIND,
			label: fileLabel("instruction", config.path),
			description: `Reads ${config.path} as instruction text`,
			config,
			inputMode: "instruction",
			resolve(ctx) {
				return resolveFileConfig(config, ctx);
			},
		};
	},
};

function parseFileConfig(value: unknown): FileExternalInput | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return null;
	}
	const record = value as Record<string, unknown>;
	if (typeof record.path !== "string" || record.path.trim() === "") {
		return null;
	}
	return {
		path: record.path,
		pollInterval: typeof record.pollInterval === "string" ? record.pollInterval : "1s",
		consume: record.consume === "keep" ? "keep" : "delete",
	};
}

async function maybeConsume(config: FileExternalInput): Promise<void> {
	if (config.consume === "delete") {
		await consumeTriggerFile(config.path);
	}
}

function createDueTracker() {
	const nextDueAtByKey = new Map<string, number>();
	return {
		isDue(key: string, pollInterval: string, nowMs = Date.now()): boolean {
			const nextDueAt = nextDueAtByKey.get(key) ?? 0;
			if (nextDueAt > nowMs) {
				return false;
			}
			const intervalMs = parseDurationMs(pollInterval, 1_000);
			nextDueAtByKey.set(key, nowMs + intervalMs);
			return true;
		},
		prune(activeKeys: ReadonlySet<string>): void {
			for (const key of [...nextDueAtByKey.keys()]) {
				if (!activeKeys.has(key)) {
					nextDueAtByKey.delete(key);
				}
			}
		},
	};
}

function resolveArmedFileConfig(
	armed: ReturnType<CoreServerSetupDeps["externalSources"]["listArmed"]>[number],
	resolveAlias: (config: FileExternalInput) => FileExternalInput,
): FileExternalInput | null {
	const parsed = parseFileConfig(armed.resolved) ?? parseFileConfig(armed.source.config);
	return parsed ? resolveAlias(parsed) : null;
}

async function pollArmedFileSource(
	armed: ExternalSourceArmingLike,
	resolveConfig: (config: FileExternalInput) => FileExternalInput,
	isDue: (key: string, pollInterval: string) => boolean,
	activeKeys: Set<string>,
	result: PollResult,
) {
	const config = resolveArmedFileConfig(armed, resolveConfig);
	if (!config) {
		result.errors.push(`${armed.id}:invalid_config`);
		return null;
	}
	const key = `${armed.instanceId}:${armed.id}`;
	activeKeys.add(key);
	if (!isDue(key, config.pollInterval)) {
		return null;
	}
	const file = await readTriggerFile(config.path);
	if (!file.exists) {
		return null;
	}
	return { config, file };
}

async function firePresenceSources(
	deps: CoreServerSetupDeps,
	result: PollResult,
	resolveConfig: (config: FileExternalInput) => FileExternalInput,
	isDue: (key: string, pollInterval: string) => boolean,
	activeKeys: Set<string>,
): Promise<void> {
	for (const armed of deps.externalSources.listArmed(FILE_EXTERNAL_PRESENCE_KIND)) {
		const target = await pollArmedFileSource(armed, resolveConfig, isDue, activeKeys, result);
		if (!target) {
			continue;
		}
		const { config } = target;
		const fired = await deps.externalSources.fire({
			instanceId: armed.instanceId,
			armingId: armed.id,
			event: { path: config.path, pollInterval: config.pollInterval },
			mergeKey: config.path,
		});
		if (!fired.ok) {
			result.errors.push(`${armed.id}:${fired.code ?? fired.error ?? "fire_failed"}`);
			continue;
		}
		await maybeConsume(config);
		result.created.push(armed.id);
	}
}

async function fireInstructionSources(
	deps: CoreServerSetupDeps,
	result: PollResult,
	resolveConfig: (config: FileExternalInput) => FileExternalInput,
	isDue: (key: string, pollInterval: string) => boolean,
	activeKeys: Set<string>,
): Promise<void> {
	for (const armed of deps.externalSources.listArmed(FILE_EXTERNAL_INSTRUCTION_KIND)) {
		const target = await pollArmedFileSource(armed, resolveConfig, isDue, activeKeys, result);
		if (!target) {
			continue;
		}
		const { config, file } = target;
		const instruction = file.content.trim();
		if (!instruction) {
			continue;
		}
		const fired = await deps.externalSources.fire({
			instanceId: armed.instanceId,
			armingId: armed.id,
			input: { instruction },
			event: { path: config.path, pollInterval: config.pollInterval },
			mergeKey: config.path,
		});
		if (!fired.ok) {
			result.errors.push(`${armed.id}:${fired.code ?? fired.error ?? "fire_failed"}`);
			continue;
		}
		await maybeConsume(config);
		result.created.push(armed.id);
	}
}

export function createFileExternalSourceProvider(
	deps: CoreServerSetupDeps,
	aliases: Partial<Record<string, string>> = {},
) {
	function applyAlias(config: FileExternalInput): FileExternalInput {
		const exact = aliases[config.path];
		if (exact) {
			return { ...config, path: exact };
		}
		for (const [template, replacement] of Object.entries(aliases)) {
			if (!replacement || !template.includes("{instanceId}")) {
				continue;
			}
			const [prefix, suffix = ""] = template.split("{instanceId}");
			if (!prefix || !config.path.startsWith(prefix) || !config.path.endsWith(suffix)) {
				continue;
			}
			const instanceId = config.path.slice(prefix.length, config.path.length - suffix.length);
			return {
				...config,
				path: replacement.includes("{instanceId}")
					? interpolateTemplate(replacement, { instanceId })
					: replacement,
			};
		}
		return config;
	}
	const due = createDueTracker();
	return deps.polling.create({
		id: "showcase-file-external",
		pollInterval: () => "50ms",
		isEnabled: () => true,
		defaultIntervalMs: 50,
		async pollOnce() {
			const result = emptyPollResult();
			const activeKeys = new Set<string>();
			await firePresenceSources(deps, result, applyAlias, due.isDue, activeKeys);
			await fireInstructionSources(deps, result, applyAlias, due.isDue, activeKeys);
			due.prune(activeKeys);
			return result;
		},
	});
}
