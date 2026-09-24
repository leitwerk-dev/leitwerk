import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	collectBaseline,
	compareRuntime,
	createTimingReport,
	formatComparison,
	runComparison,
	validReport,
	writeTimingReport,
} from "./test-runtime.mjs";

function report(seconds = 100, runId = "1", attempt = "1") {
	return createTimingReport(
		[
			{ phase: "lint", seconds: 500 },
			{ phase: "parity:build", seconds: 500 },
			{ phase: "test:unit", seconds: seconds * 0.6 },
			{ phase: "test:browser", seconds: seconds * 0.4 },
		],
		{ GITHUB_RUN_ID: runId, GITHUB_RUN_ATTEMPT: attempt },
	);
}

function run(id: number) {
	return {
		id,
		run_attempt: 1,
		created_at: new Date(Date.UTC(2026, 8, 1, 0, id)).toISOString(),
		conclusion: "success",
		event: "push",
		head_branch: "main",
	};
}

function fixtureClient(runs = Array.from({ length: 10 }, (_, index) => run(index + 1))) {
	return {
		get: vi.fn(async (endpoint: string) => {
			if (endpoint.includes("/workflows/")) return { workflow_runs: [...runs] };
			return { artifacts: [{ name: "test-runtime-attempt-1", expired: false }] };
		}),
		download: vi.fn(async (id: number) => report(100, String(id))),
	};
}

const directories: string[] = [];
function temporaryDirectory() {
	const directory = mkdtempSync(path.join(tmpdir(), "test-runtime-test-"));
	directories.push(directory);
	return directory;
}

afterEach(() => {
	vi.restoreAllMocks();
	for (const directory of directories.splice(0))
		rmSync(directory, { recursive: true, force: true });
});

describe("test runtime measurement", () => {
	it("records only test phases without rounding", () => {
		const filename = path.join(temporaryDirectory(), "test-runtime.json");
		writeTimingReport(filename, [
			{ phase: "typecheck", seconds: 999 },
			{ phase: "test:server-start", seconds: 1.23456789 },
			{ phase: "test:browser", seconds: 4.56789 },
		]);
		const saved = JSON.parse(readFileSync(filename, "utf8"));
		expect(saved.phases).toEqual([
			{ phase: "test:server-start", seconds: 1.23456789 },
			{ phase: "test:browser", seconds: 4.56789 },
		]);
		expect(validReport(saved)).toBe(true);
	});
	it("keeps unwritable timing output nonblocking", () => {
		vi.spyOn(console, "info").mockImplementation(() => {});
		expect(() => writeTimingReport(temporaryDirectory(), report().phases)).not.toThrow();
		expect(console.info).toHaveBeenCalledWith(expect.stringContaining("unavailable"));
	});
	it.each([
		undefined,
		{},
		{ ...report(), version: 2 },
		{ ...report(), phases: [] },
		{ ...report(), phases: [{ phase: "test:unit", seconds: Number.NaN }] },
		{ ...report(), phases: [{ phase: "test:unit", seconds: -1 }] },
		{ ...report(), phases: [report().phases[0], report().phases[0]] },
	])("rejects unusable reports: %j", (value) => expect(validReport(value)).toBe(false));
});

describe("runtime comparison", () => {
	it.each([
		[90, false],
		[100, false],
		[104, false],
		[104.999, false],
		[105, true],
		[105.001, true],
	])("compares %s seconds with a 100-second baseline without rounding", (seconds, warning) => {
		expect(
			compareRuntime(
				report(seconds as number),
				Array.from({ length: 10 }, () => report()),
			).warning,
		).toBe(warning);
	});
	it("uses the arithmetic mean of run totals", () => {
		const samples = Array.from({ length: 10 }, (_, index) => report(55 + index * 10));
		expect(compareRuntime(report(104), samples)).toEqual({
			baselineSeconds: 100,
			currentSeconds: 104,
			growthPercent: 4,
			warning: false,
		});
	});
	it("includes phase averages and a nonblocking warning in the summary", () => {
		const output = formatComparison(
			report(105),
			Array.from({ length: 10 }, () => report()),
		);
		expect(output.warning).toContain("+5.00%");
		expect(output.summary).toContain("nonblocking");
		expect(output.summary).toContain("| `test:unit` | 63.0s | 60.0s |");
	});
	it("reports baseline collection until all ten samples are present", () => {
		expect(formatComparison(report(200), [report()])).toEqual({
			summary:
				"Collecting baseline: 1/10 compatible successful main runs. Runtime comparison skipped.",
		});
	});
});

describe("historical baseline", () => {
	it("selects newest successful main push runs and counts each run once", async () => {
		const runs = Array.from({ length: 12 }, (_, index) => run(index + 1));
		runs.push(
			run(12),
			{ ...run(13), conclusion: "failure" },
			{ ...run(14), conclusion: "cancelled" },
			{ ...run(15), event: "pull_request" },
			{ ...run(16), head_branch: "feature" },
		);
		const client = fixtureClient(runs);
		const samples = await collectBaseline(report(), client);
		expect(samples.map((sample: { runId: string }) => sample.runId)).toEqual([
			"12",
			"11",
			"10",
			"9",
			"8",
			"7",
			"6",
			"5",
			"4",
			"3",
		]);
		expect(client.download).toHaveBeenCalledTimes(10);
	});
	it("ignores expired, missing, and earlier-attempt artifacts", async () => {
		const client = fixtureClient();
		client.get.mockImplementation(async (endpoint) => {
			if (endpoint.includes("/workflows/"))
				return {
					workflow_runs: [
						run(1),
						run(2),
						{ ...run(3), run_attempt: 2 },
						{ ...run(4), run_attempt: 2 },
					],
				};
			if (endpoint.includes("/1/")) return { artifacts: [] };
			if (endpoint.includes("/2/"))
				return { artifacts: [{ name: "test-runtime-attempt-1", expired: true }] };
			if (endpoint.includes("/3/"))
				return { artifacts: [{ name: "test-runtime-attempt-1", expired: false }] };
			return { artifacts: [{ name: "test-runtime-attempt-2", expired: false }] };
		});
		client.download.mockResolvedValue(report(100, "4", "2"));
		expect(await collectBaseline(report(), client)).toEqual([report(100, "4", "2")]);
		expect(client.download).toHaveBeenCalledExactlyOnceWith(4, "test-runtime-attempt-2");
	});
	it.each([
		"os",
		"image",
		"arch",
		"cpus",
		"nodeMajor",
		"version",
		"phases",
		"runId",
		"attempt",
	])("skips incompatible or incorrect %s", async (field) => {
		const client = fixtureClient([run(1)]);
		const sample = report();
		if (field in sample.environment) {
			const value = sample.environment[field];
			sample.environment[field] = typeof value === "number" ? value + 1 : "different";
		} else if (field === "phases") sample.phases = [{ phase: "test:e2e", seconds: 100 }];
		else sample[field] = "different";
		client.download.mockResolvedValue(sample);
		expect(await collectBaseline(report(), client)).toEqual([]);
	});
	it("continues across pages when recent runs lack artifacts", async () => {
		const client = fixtureClient();
		client.get.mockImplementation(async (endpoint) => {
			if (endpoint.includes("/workflows/"))
				return {
					workflow_runs: endpoint.endsWith("page=1")
						? Array.from({ length: 100 }, (_, index) => run(101 + index))
						: Array.from({ length: 10 }, (_, index) => run(1 + index)),
				};
			const id = Number(endpoint.match(/runs\/(\d+)/u)?.[1]);
			return { artifacts: id > 100 ? [] : [{ name: "test-runtime-attempt-1", expired: false }] };
		});
		expect(await collectBaseline(report(), client)).toHaveLength(10);
		expect(client.get).toHaveBeenCalledWith(expect.stringContaining("page=2"));
	});
});

describe("advisory output", () => {
	it.each([
		"warning",
		"api-error",
		"missing-current",
		"no-history",
	])("keeps %s nonblocking and writes a summary", async (scenario) => {
		const directory = temporaryDirectory();
		const filename = path.join(directory, "test-runtime.json");
		const summary = path.join(directory, "summary.md");
		if (scenario !== "missing-current") writeFileSync(filename, JSON.stringify(report(105)));
		const client = fixtureClient(scenario === "no-history" ? [] : undefined);
		if (scenario === "api-error") client.get.mockRejectedValue(new Error("HTTP 403"));
		vi.spyOn(console, "info").mockImplementation(() => {});
		vi.spyOn(console, "warn").mockImplementation(() => {});
		const output = await runComparison(
			{ LEITWERK_TEST_TIMINGS_FILE: filename, GITHUB_STEP_SUMMARY: summary },
			client,
		);
		expect(readFileSync(summary, "utf8")).toContain(output.summary);
		if (scenario === "warning")
			expect(console.warn).toHaveBeenCalledWith(
				expect.stringContaining("::warning::Test runtime 105.0s"),
			);
		else {
			expect(console.warn).not.toHaveBeenCalled();
			expect(output.summary).toContain(scenario === "no-history" ? "0/10" : "unavailable");
		}
	});
});
