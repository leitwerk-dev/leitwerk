import {
	type LaunchRun,
	type PhysicalWorkerStart,
	type StartupInterval,
	startupInterval,
} from "@leitwerk-dev/domain";

export interface BenchmarkSample {
	index: number;
	warmup: boolean;
	idempotencyKey: string;
	startedAt: string;
	endedAt?: string;
	outcome: "pending" | "completed" | "failed" | "timeout" | "interrupted";
	launchRunId?: string;
	instanceId?: string | null;
	launchRun?: LaunchRun;
	startup?: { workerStarts?: PhysicalWorkerStart[] };
	turnRecords?: unknown[];
	launchTimings?: Record<string, StartupInterval>;
	error?: string;
}

export function statistics(values: (number | null | undefined)[]) {
	const sorted = values
		.filter(
			(value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0,
		)
		.sort((a, b) => a - b);
	const n = sorted.length;
	return {
		count: n,
		median: n ? (sorted[Math.floor((n - 1) / 2)] + sorted[Math.ceil((n - 1) / 2)]) / 2 : null,
		p90: n ? sorted[Math.ceil(n * 0.9) - 1] : null,
		maximum: n ? sorted[n - 1] : null,
	};
}

export function imageCohort(worker?: Pick<PhysicalWorkerStart, "observations">) {
	const milestones = new Set((worker?.observations ?? []).map((entry) => entry.milestone));
	if (milestones.has("image_pull_started") && milestones.has("image_pull_finished"))
		return "pulled";
	if (milestones.has("image_cached") && !milestones.has("image_pull_started")) return "cached";
	return "unknown";
}

export function launchTimings(
	launchRun: Pick<LaunchRun, "createdAt"> | undefined,
	startup: BenchmarkSample["startup"],
): Record<string, StartupInterval> {
	const initial = startup?.workerStarts?.[0];
	const receipt = (milestone: string) =>
		initial?.observations?.find((entry) => entry.milestone === milestone)?.observedAt;
	return {
		launchToFirstText: startupInterval(launchRun?.createdAt, receipt("first_text")),
		launchToPrompt: startupInterval(launchRun?.createdAt, receipt("prompt_started")),
		apiLaunchPreparation: startupInterval(
			launchRun?.createdAt,
			initial?.intervals?.requestToConnection?.start,
		),
	};
}

export function report(samples: BenchmarkSample[], expectedLaunches = 30): string {
	const measured = samples.filter((sample) => !sample.warmup);
	const lines = [
		"# Worker startup benchmark",
		"",
		`Measured launches: ${measured.length} / ${expectedLaunches}; warm-ups: ${samples.length - measured.length}; failures/timeouts: ${measured.filter((sample) => sample.outcome !== "completed").length}; warm-up failures/timeouts: ${samples.filter((sample) => sample.warmup && sample.outcome !== "completed").length}.`,
		"",
		"All attempted launches are retained. Missing and invalid intervals are excluded from durations and counted in coverage. Kubernetes intervals may overlap; do not sum them. Prompt-to-first-text includes provider response time.",
		"",
		"| Cohort | Stage | Available / launches | Median ms | Nearest-rank p90 ms | Maximum ms |",
		"|---|---|---:|---:|---:|---:|---:|",
	];
	const intervals = (sample: BenchmarkSample) => ({
		...sample.startup?.workerStarts?.[0]?.intervals,
		...sample.launchTimings,
	});
	for (const cohort of ["all", "cached", "pulled", "unknown"]) {
		const selected = measured.filter(
			(sample) => cohort === "all" || imageCohort(sample.startup?.workerStarts?.[0]) === cohort,
		);
		const stages = new Set(selected.flatMap((sample) => Object.keys(intervals(sample))));
		for (const stage of stages) {
			const stats = statistics(
				selected.map((sample) => {
					const value = intervals(sample)[stage];
					return value?.status === "available" ? value.durationMs : null;
				}),
			);
			lines.push(
				`| ${cohort} | ${stage.replace(/[|\r\n]/g, " ")} | ${stats.count} / ${selected.length} | ${stats.median ?? "unavailable"} | ${stats.p90 ?? "unavailable"} | ${stats.maximum ?? "unavailable"} |`,
			);
		}
	}
	lines.push(
		"",
		`Launches with multiple physical workers: ${measured.filter((sample) => (sample.startup?.workerStarts?.length ?? 0) > 1).length}. Stage rows describe the initial physical worker; raw results retain all replacements.`,
		"",
		"Assess critical-path contribution and coverage before comparing candidates. Binding windows are bounds, not exact storage duration. Container source times and server receipt times use different clocks.",
	);
	return `${lines.join("\n")}\n`;
}
