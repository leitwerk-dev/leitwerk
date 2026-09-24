import { execFileSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { availableParallelism, tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const baselineSize = 10;
const thresholdPercent = 5;
const artifactPrefix = "test-runtime-attempt-";

/** @internal */
export function createTimingReport(timings, env = process.env) {
	return {
		version: 1,
		runId: env.GITHUB_RUN_ID,
		attempt: env.GITHUB_RUN_ATTEMPT,
		environment: {
			os: process.platform,
			image: env.ImageOS ?? process.platform,
			arch: process.arch,
			cpus: availableParallelism(),
			nodeMajor: Number(process.versions.node.split(".")[0]),
		},
		phases: timings.filter(({ phase }) => phase.startsWith("test:")),
	};
}

/** @internal */
export function writeTimingReport(filename, timings, env = process.env) {
	if (!filename) return;
	try {
		writeFileSync(filename, `${JSON.stringify(createTimingReport(timings, env))}\n`);
	} catch (error) {
		console.info(`[test:full] Runtime timing report unavailable: ${error.message}`);
	}
}

/** @internal */
export function validReport(report) {
	return (
		report?.version === 1 &&
		["os", "image", "arch"].every((key) => typeof report.environment?.[key] === "string") &&
		["cpus", "nodeMajor"].every(
			(key) => Number.isInteger(report.environment?.[key]) && report.environment[key] > 0,
		) &&
		Array.isArray(report.phases) &&
		report.phases.length > 0 &&
		report.phases.every(
			(entry) =>
				typeof entry?.phase === "string" &&
				/^test:[a-z0-9:-]+$/u.test(entry.phase) &&
				Number.isFinite(entry.seconds) &&
				entry.seconds > 0,
		) &&
		new Set(report.phases.map(({ phase }) => phase)).size === report.phases.length
	);
}

function compatible(current, sample) {
	return (
		validReport(sample) &&
		Object.keys(current.environment).every(
			(key) => current.environment[key] === sample.environment[key],
		) &&
		current.phases.length === sample.phases.length &&
		current.phases.every(({ phase }) => sample.phases.some((entry) => entry.phase === phase))
	);
}

function total(report) {
	return report.phases.reduce((sum, { seconds }) => sum + seconds, 0);
}

/** @internal */
export function compareRuntime(current, samples) {
	if (!validReport(current)) throw new Error("Invalid current test timing report");
	if (samples.length !== baselineSize || samples.some((sample) => !compatible(current, sample))) {
		throw new Error("Expected ten compatible baseline samples");
	}
	const baselineSeconds = samples.reduce((sum, sample) => sum + total(sample), 0) / baselineSize;
	const currentSeconds = total(current);
	return {
		baselineSeconds,
		currentSeconds,
		growthPercent: ((currentSeconds - baselineSeconds) / baselineSeconds) * 100,
		warning: currentSeconds * 100 >= baselineSeconds * (100 + thresholdPercent),
	};
}

/** @internal */
export async function collectBaseline(current, { get, download }, now = new Date()) {
	const since = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();
	const samples = [];
	const seen = new Set();
	// GitHub caps filtered workflow-run queries at 1,000 results.
	for (let page = 1; page <= 10; page++) {
		const result = await get(
			`actions/workflows/ci.yml/runs?branch=main&event=push&status=success&created=${encodeURIComponent(`>=${since}`)}&per_page=100&page=${page}`,
		);
		const runs = result.workflow_runs.sort((a, b) => b.created_at.localeCompare(a.created_at));
		for (const run of runs) {
			if (
				seen.has(run.id) ||
				run.conclusion !== "success" ||
				run.event !== "push" ||
				run.head_branch !== "main"
			)
				continue;
			seen.add(run.id);
			const name = `${artifactPrefix}${run.run_attempt}`;
			const artifacts = await get(`actions/runs/${run.id}/artifacts?name=${name}&per_page=100`);
			if (!artifacts.artifacts.some((artifact) => artifact.name === name && !artifact.expired)) {
				continue;
			}
			const sample = await download(run.id, name);
			if (
				compatible(current, sample) &&
				sample.runId === String(run.id) &&
				sample.attempt === String(run.run_attempt)
			)
				samples.push(sample);
			if (samples.length === baselineSize) return samples;
		}
		if (runs.length < 100) break;
	}
	return samples;
}

/** @internal */
export function formatComparison(current, samples) {
	if (samples.length < baselineSize) {
		return {
			summary: `Collecting baseline: ${samples.length}/${baselineSize} compatible successful main runs. Runtime comparison skipped.`,
		};
	}
	const result = compareRuntime(current, samples);
	const change = `${result.growthPercent >= 0 ? "+" : ""}${result.growthPercent.toFixed(2)}%`;
	const message = `Test runtime ${result.currentSeconds.toFixed(1)}s; main average ${result.baselineSeconds.toFixed(1)}s (${samples.length} runs); change ${change}.`;
	return {
		warning: result.warning
			? `${message} Growth reached the ${thresholdPercent}% advisory threshold.`
			: undefined,
		summary: [
			message,
			"",
			result.warning
				? "**Runtime growth warning (nonblocking).**"
				: "Runtime growth is below the warning threshold.",
			"",
			"| Test phase | PR | Main average |",
			"|---|---:|---:|",
			...current.phases.map(({ phase, seconds }) => {
				const mean =
					samples.reduce(
						(sum, sample) => sum + sample.phases.find((entry) => entry.phase === phase).seconds,
						0,
					) / samples.length;
				return `| \`${phase}\` | ${seconds.toFixed(1)}s | ${mean.toFixed(1)}s |`;
			}),
		].join("\n"),
	};
}

function githubClient(env) {
	const repository = env.GITHUB_REPOSITORY;
	if (!repository || !env.GH_TOKEN) throw new Error("GitHub repository and token are required");
	const startedAt = performance.now();
	function checkDeadline() {
		// Leave time to report an unavailable comparison before the five-minute step timeout.
		if (performance.now() - startedAt > 240_000)
			throw new Error("Timing lookup exceeded four minutes");
	}
	return {
		async get(endpoint) {
			checkDeadline();
			const response = await fetch(
				`${env.GITHUB_API_URL ?? "https://api.github.com"}/repos/${repository}/${endpoint}`,
				{
					headers: {
						Accept: "application/vnd.github+json",
						Authorization: `Bearer ${env.GH_TOKEN}`,
						"X-GitHub-Api-Version": "2022-11-28",
					},
					signal: AbortSignal.timeout(30_000),
				},
			);
			if (!response.ok) throw new Error(`GitHub timing lookup failed: HTTP ${response.status}`);
			return response.json();
		},
		download(runId, name) {
			checkDeadline();
			const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-test-runtime-"));
			try {
				execFileSync(
					"gh",
					[
						"run",
						"download",
						String(runId),
						"--repo",
						repository,
						"--name",
						name,
						"--dir",
						directory,
					],
					{ env, timeout: 30_000, stdio: "pipe" },
				);
				try {
					return JSON.parse(readFileSync(path.join(directory, "test-runtime.json"), "utf8"));
				} catch {
					return undefined;
				}
			} finally {
				rmSync(directory, { recursive: true, force: true });
			}
		},
	};
}

/** @internal */
export async function runComparison(env = process.env, client) {
	let output;
	try {
		const current = JSON.parse(readFileSync(env.LEITWERK_TEST_TIMINGS_FILE, "utf8"));
		if (!validReport(current)) throw new Error("Invalid current test timing report");
		const samples = await collectBaseline(current, client ?? githubClient(env));
		output = formatComparison(current, samples);
	} catch (error) {
		output = { summary: `Test runtime comparison unavailable: ${error.message}` };
	}
	if (output.warning) console.warn(`::warning::${output.warning}`);
	console.info(output.summary);
	if (env.GITHUB_STEP_SUMMARY) {
		try {
			appendFileSync(
				env.GITHUB_STEP_SUMMARY,
				`\n## Test runtime comparison\n\n${output.summary}\n`,
			);
		} catch (error) {
			console.info(`Could not write runtime summary: ${error.message}`);
		}
	}
	return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	await runComparison();
}
