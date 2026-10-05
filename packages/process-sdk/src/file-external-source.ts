import { readFile, unlink } from "node:fs/promises";
import { emptyPollResult, parseDurationMs } from "@leitwerk-dev/watcher-utils";
import type { CoreServerSetupDeps } from "./core-capabilities.js";
import type { ExternalActionSource } from "./extension-api.js";
import { isEnoent } from "./fs-utils.js";

/** @internal */
export interface FileExternalInput {
	/** @internal */
	path: string;
	/** @internal */
	pollInterval: string;
	/** @internal */
	consume: "delete" | "keep";
}

/** @internal */
export function defineFileExternalSource(
	input: FileExternalInput,
	metadata: Pick<ExternalActionSource, "kind" | "label" | "description" | "inputMode">,
): ExternalActionSource {
	const config = { path: input.path, pollInterval: input.pollInterval, consume: input.consume };
	return {
		...metadata,
		config,
		resolve: (ctx) => ({
			...config,
			path: config.path.replaceAll("{instanceId}", ctx.process.id),
		}),
	};
}

function parseFileConfig(value: unknown): FileExternalInput | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	if (typeof record.path !== "string" || record.path.trim() === "") return null;
	return {
		path: record.path,
		pollInterval: typeof record.pollInterval === "string" ? record.pollInterval : "1s",
		consume: record.consume === "keep" ? "keep" : "delete",
	};
}

/** A missing file is distinct from an empty presence trigger. @internal */
export async function readTriggerFile(filePath: string): Promise<string | null> {
	try {
		return await readFile(filePath, "utf8");
	} catch (error) {
		if (isEnoent(error)) return null;
		throw error;
	}
}

/** @internal */
export async function consumeTriggerFile(filePath: string): Promise<void> {
	try {
		await unlink(filePath);
	} catch (error) {
		if (!isEnoent(error)) throw error;
	}
}

function applyAlias(config: FileExternalInput, aliases: Partial<Record<string, string>>) {
	const exact = aliases[config.path];
	if (exact) return { ...config, path: exact };
	for (const [template, replacement] of Object.entries(aliases)) {
		if (!replacement || !template.includes("{instanceId}")) continue;
		const [prefix, suffix = ""] = template.split("{instanceId}");
		if (!prefix || !config.path.startsWith(prefix) || !config.path.endsWith(suffix)) continue;
		const instanceId = config.path.slice(prefix.length, config.path.length - suffix.length);
		return { ...config, path: replacement.replaceAll("{instanceId}", instanceId) };
	}
	return config;
}

/** Poll extension-owned file sources, consuming triggers only after successful admission. @internal */
export function createFileExternalSourceProvider(
	deps: CoreServerSetupDeps,
	options: {
		/** @internal */
		id: string;
		/** @internal */
		kind: string;
		/** @internal */
		inputMode: "none" | "instruction";
		/** @internal */
		aliases?: Partial<Record<string, string>>;
	},
) {
	const nextDueAt = new Map<string, number>();
	return deps.polling.create({
		id: options.id,
		pollInterval: () => "50ms",
		isEnabled: () => true,
		defaultIntervalMs: 50,
		async pollOnce() {
			const result = emptyPollResult();
			const activeKeys = new Set<string>();
			for (const armed of deps.externalSources.listArmed(options.kind)) {
				const parsed = parseFileConfig(armed.resolved) ?? parseFileConfig(armed.source.config);
				if (!parsed) {
					result.errors.push(`${armed.id}:invalid_config`);
					continue;
				}
				const config = applyAlias(parsed, options.aliases ?? {});
				const key = `${armed.instanceId}:${armed.id}`;
				activeKeys.add(key);
				const now = Date.now();
				if ((nextDueAt.get(key) ?? 0) > now) continue;
				nextDueAt.set(key, now + parseDurationMs(config.pollInterval, 1_000));
				const content = await readTriggerFile(config.path);
				if (content === null || (options.inputMode === "instruction" && !content.trim())) continue;
				const fired = await deps.externalSources.fire({
					instanceId: armed.instanceId,
					armingId: armed.id,
					...(options.inputMode === "instruction"
						? { input: { instruction: content.trim() } }
						: {}),
					event: { path: config.path, pollInterval: config.pollInterval },
					mergeKey: config.path,
				});
				if (!fired.ok) {
					result.errors.push(`${armed.id}:${fired.code ?? fired.error ?? "fire_failed"}`);
					continue;
				}
				if (config.consume === "delete") await consumeTriggerFile(config.path);
				result.created.push(armed.id);
			}
			for (const key of nextDueAt.keys()) {
				if (!activeKeys.has(key)) nextDueAt.delete(key);
			}
			return result;
		},
	});
}
