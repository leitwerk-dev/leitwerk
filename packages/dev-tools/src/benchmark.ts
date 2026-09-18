import { randomUUID } from "node:crypto";
import { appendFileSync, chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isUnknownRecord } from "@leitwerk-dev/domain";
import type {
	LaunchersResponseBody,
	LaunchRunResponseBody,
	ProcessDetailUiSnapshotResponseBody,
	ProcessDiagnosticsData,
	StartLaunchRunResponseBody,
} from "@leitwerk-dev/protocol";
import { parse } from "yaml";
import { type KubernetesEvidenceOptions, kubernetesEvidence } from "./benchmark-kubernetes.js";
import { type BenchmarkSample, launchTimings, report } from "./benchmark-report.js";

export type { KubernetesEvidenceOptions } from "./benchmark-kubernetes.js";
export {
	type BenchmarkSample,
	imageCohort,
	launchTimings,
	report,
	statistics,
} from "./benchmark-report.js";

/** @internal */
export interface WorkerStartupBenchmarkOptions {
	/** @internal */
	apiConfig: string;
	/** @internal */
	launcherId: string;
	/** @internal */
	modelProfileId: string;
	/** @internal */
	launcherInput: Record<string, unknown>;
	/** @internal */
	title: string;
	/** @internal */
	candidate: string;
	/** @internal */
	output: string;
	/** @internal */
	samples?: number;
	/** @internal */
	warmups?: number;
	/** @internal */
	timeoutMs?: number;
	/** @internal */
	pollIntervalMs?: number;
	/** @internal */
	kubernetes?: KubernetesEvidenceOptions;
	/** @internal */
	signal?: AbortSignal;
}

class ApiError extends Error {
	constructor(readonly status: number) {
		super(`API HTTP ${status}`);
	}
}

function credentials(file: string): { base: URL; token: string } {
	let parsed: unknown;
	try {
		parsed = parse(readFileSync(file, "utf8"));
	} catch {
		throw new Error("Cannot read a valid API client configuration");
	}
	if (
		!isUnknownRecord(parsed) ||
		typeof parsed.base_url !== "string" ||
		typeof parsed.api_token !== "string" ||
		!parsed.api_token.trim()
	)
		throw new Error("API client configuration needs base_url and a nonempty api_token");
	let base: URL;
	try {
		base = new URL(parsed.base_url);
	} catch {
		throw new Error("API base_url must be an HTTP(S) URL");
	}
	if (
		!["http:", "https:"].includes(base.protocol) ||
		base.username ||
		base.password ||
		base.search ||
		base.hash
	)
		throw new Error("API base_url must be an HTTP(S) URL without credentials, query or fragment");
	chmodSync(file, 0o600);
	return { base, token: parsed.api_token.trim() };
}

function positiveInteger(value: number, label: string, minimum = 1) {
	if (!Number.isSafeInteger(value) || value < minimum)
		throw new Error(`${label} must be an integer of at least ${minimum}`);
	return value;
}

/** Launch sequentially; keep uncertain attempts and their request identities for diagnosis. */
/** @internal */
export async function runWorkerStartupBenchmark(options: WorkerStartupBenchmarkOptions) {
	for (const field of [
		"apiConfig",
		"launcherId",
		"modelProfileId",
		"title",
		"candidate",
		"output",
	] as const)
		if (!options[field]?.trim()) throw new Error(`${field} is required`);
	if (!isUnknownRecord(options.launcherInput)) throw new Error("launcherInput must be an object");
	const count = positiveInteger(options.samples ?? 30, "samples");
	const warmups = positiveInteger(options.warmups ?? 0, "warmups", 0);
	const timeoutMs = positiveInteger(options.timeoutMs ?? 180_000, "timeoutMs");
	const pollIntervalMs = positiveInteger(options.pollIntervalMs ?? 500, "pollIntervalMs");
	options.signal?.throwIfAborted();
	const { base, token } = credentials(options.apiConfig);
	const api = async <T>(
		route: string,
		init: RequestInit = {},
		deadlineSignal?: AbortSignal,
	): Promise<T> => {
		let response: Response;
		try {
			response = await fetch(new URL(route, base), {
				...init,
				redirect: "error",
				signal: AbortSignal.any([
					AbortSignal.timeout(10_000),
					...(deadlineSignal ? [deadlineSignal] : []),
					...(options.signal ? [options.signal] : []),
				]),
				headers: {
					authorization: `Bearer ${token}`,
					"content-type": "application/json",
					...init.headers,
				},
			});
		} catch {
			throw new Error(options.signal?.aborted ? "Benchmark interrupted" : "API request failed");
		}
		if (!response.ok) throw new ApiError(response.status);
		try {
			return (await response.json()) as T;
		} catch {
			throw new Error("API returned invalid JSON");
		}
	};
	const catalog = await api<LaunchersResponseBody>("/api/launchers");
	const launcher = catalog.launchers?.find((entry) => entry.id === options.launcherId);
	if (!launcher) throw new Error("Requested launcher is unavailable");
	const profile = launcher.modelConfigSchema?.availableProfiles?.find(
		(entry) => entry.id === options.modelProfileId,
	);
	if (!profile || profile.availability !== "available")
		throw new Error("Requested model profile is unavailable for this launcher");
	const provenance = options.kubernetes ? kubernetesEvidence(options.kubernetes) : null;
	const output = path.resolve(options.output);
	mkdirSync(path.dirname(output), { recursive: true });
	// Refuse an existing output directory instead of replacing retained evidence.
	mkdirSync(output, { mode: 0o700 });
	const write = (name: string, value: unknown) =>
		writeFileSync(path.join(output, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	write("inputs.json", {
		launcherId: options.launcherId,
		modelProfileId: options.modelProfileId,
		launcherInput: options.launcherInput,
		title: options.title,
		candidate: options.candidate,
		baseUrl: base.origin,
		measuredLaunches: count,
		warmups,
		timeoutMs,
		provenance,
	});
	const rawPath = path.join(output, "results.jsonl");
	writeFileSync(rawPath, "", { flag: "wx", mode: 0o600 });
	const samples: BenchmarkSample[] = [];
	writeFileSync(path.join(output, "report.md"), report(samples, count), { mode: 0o600 });
	let stop = false;
	for (let index = 0; index < warmups + count && !stop; index++) {
		if (options.signal?.aborted) break;
		const sample: BenchmarkSample = {
			index,
			warmup: index < warmups,
			idempotencyKey: randomUUID(),
			startedAt: new Date().toISOString(),
			outcome: "pending",
		};
		// Journal before the request so even an interrupted launch can be reconciled.
		appendFileSync(path.join(output, "launches.jsonl"), `${JSON.stringify(sample)}\n`, {
			mode: 0o600,
		});
		// One signal owns the deadline across requests, response bodies and polling.
		// Do not infer timer cancellation from a separate wall-clock comparison.
		const deadlineSignal = AbortSignal.timeout(timeoutMs);
		const sampleSignal = AbortSignal.any([
			deadlineSignal,
			...(options.signal ? [options.signal] : []),
		]);
		try {
			let launch: StartLaunchRunResponseBody | undefined;
			for (let attempt = 0; attempt < 3; attempt++) {
				try {
					launch = await api<StartLaunchRunResponseBody>(
						`/api/launchers/${encodeURIComponent(options.launcherId)}/launch-runs`,
						{
							method: "POST",
							headers: { "idempotency-key": sample.idempotencyKey },
							body: JSON.stringify({
								title: options.title,
								launcherInput: options.launcherInput,
								modelConfig: { defaultModelProfileId: options.modelProfileId },
							}),
						},
						deadlineSignal,
					);
					if (typeof launch.launchRunId !== "string" || !launch.launchRunId)
						throw new Error("API response did not identify the launch run");
					break;
				} catch (error) {
					if (
						attempt === 2 ||
						options.signal?.aborted ||
						deadlineSignal.aborted ||
						(error instanceof ApiError && error.status < 500 && ![408, 429].includes(error.status))
					)
						throw error;
				}
			}
			if (!launch) throw new Error("Launch was not accepted");
			sample.launchRunId = launch.launchRunId;
			sample.instanceId = launch.instanceId;
			while (!deadlineSignal.aborted) {
				const { launchRun } = await api<LaunchRunResponseBody>(
					`/api/launch-runs/${encodeURIComponent(sample.launchRunId)}`,
					{},
					deadlineSignal,
				);
				sample.launchRun = launchRun;
				sample.instanceId ??= launchRun.instanceId;
				if (sample.instanceId) {
					const detail = await api<ProcessDiagnosticsData>(
						`/api/processes/${encodeURIComponent(sample.instanceId)}`,
						{},
						deadlineSignal,
					);
					const snapshot = await api<ProcessDetailUiSnapshotResponseBody>(
						`/api/processes/${encodeURIComponent(sample.instanceId)}/ui-snapshot`,
						{},
						deadlineSignal,
					);
					sample.startup = snapshot.startup;
					sample.turnRecords = detail.turnRecords;
					// A later turn may start another generation. Wait for the whole process.
					if (detail.process.lifecycleStatus === "completed") {
						sample.outcome = "completed";
						break;
					}
					if (detail.process.lifecycleStatus === "aborted") {
						sample.outcome = "failed";
						break;
					}
					if (
						detail.process.lifecycleStatus === "error" ||
						detail.turnRecords?.some((record) => record.status === "failed")
					) {
						sample.outcome = "failed";
						stop = true;
						break;
					}
				}
				if (["failed", "cancelled"].includes(launchRun.status)) {
					sample.outcome = "failed";
					stop = !!sample.instanceId;
					break;
				}
				await delay(pollIntervalMs, undefined, { signal: sampleSignal });
			}
			if (sample.outcome === "pending") {
				sample.outcome = "timeout";
				stop = true;
			}
		} catch (error) {
			sample.outcome = options.signal?.aborted
				? "interrupted"
				: deadlineSignal.aborted
					? "timeout"
					: "failed";
			sample.error = options.signal?.aborted
				? "Benchmark interrupted"
				: error instanceof ApiError
					? error.message
					: "Benchmark stopped after an uncertain API outcome";
			stop = true;
		}
		sample.launchTimings = launchTimings(sample.launchRun, sample.startup);
		sample.endedAt = new Date().toISOString();
		samples.push(sample);
		appendFileSync(rawPath, `${JSON.stringify(sample)}\n`, { mode: 0o600 });
		writeFileSync(path.join(output, "report.md"), report(samples, count), { mode: 0o600 });
		console.info(`Sample ${index + 1}${sample.warmup ? " (warm-up)" : ""}: ${sample.outcome}`);
	}
	const complete = samples.filter((sample) => !sample.warmup).length === count;
	return {
		/** @internal */
		samples,
		/** @internal */
		complete,
		/** @internal */
		succeeded: complete && samples.every((sample) => sample.outcome === "completed"),
		/** @internal */
		reportPath: path.join(output, "report.md"),
	};
}
