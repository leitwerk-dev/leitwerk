import { spawnSync } from "node:child_process";
import { appendFileSync, closeSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";
import { writeTimingReport } from "./test-runtime.mjs";
import { validationEnvironment } from "./validation-environment.ts";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
activateDevelopmentComposition(process.cwd());
const phases = [
	"lint",
	"parity:build",
	"test:server-start",
	"test:default-worker",
	"check:boundaries",
	"release:check",
	"typecheck",
	"test:parity:built",
	"test:unit",
	"test:integration",
	"test:e2e",
	"test:browser",
];

const validationEnv = validationEnvironment();
const quietPhases = new Set(["lint", "test:unit", "test:integration", "test:e2e", "test:browser"]);
let logDir: string | undefined;
const startedAt = performance.now();
const timings: Array<{ phase: string; seconds: number }> = [];
for (const phase of phases) {
	console.info(`[test:full] ${phase}`);
	const phaseStartedAt = performance.now();
	const quiet = quietPhases.has(phase);
	if (quiet && !logDir) {
		logDir = mkdtempSync(path.join(tmpdir(), "leitwerk-test-full-"));
		console.info(`[test:full] detailed logs: ${logDir}`);
	}
	const logPath = quiet && logDir ? path.join(logDir, `${phase}.log`) : undefined;
	const logFd = logPath === undefined ? undefined : openSync(logPath, "w");
	let result: ReturnType<typeof spawnSync>;
	try {
		result = spawnSync(npm, ["run", "--silent", phase], {
			cwd: process.cwd(),
			env: {
				...validationEnv,
				TURBO_DISABLE_UPDATE_CHECK: "1",
				NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" "),
			},
			stdio: logFd === undefined ? "inherit" : ["inherit", logFd, logFd],
		});
	} finally {
		if (logFd !== undefined) closeSync(logFd);
	}
	if (logPath && (result.error || result.status !== 0)) {
		console.error(`[test:full] ${phase} failed; output from ${logPath}:`);
		process.stderr.write(readFileSync(logPath));
	}
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	if (logPath) {
		const output = readFileSync(logPath, "utf8");
		if (phase === "lint") {
			const annotations = output.match(/^::(?:warning|notice) /gm)?.length ?? 0;
			if (annotations)
				console.info(`[test:full] lint: ${annotations} annotations (see ${logPath})`);
		} else {
			const summaries = output
				.split("\n")
				.filter((line) =>
					phase === "test:browser"
						? /\b\d+ passed \([\d.]+s\)/.test(line)
						: /^\s*(?:Test Files|Tests)\s+/.test(line),
				);
			for (const summary of summaries) console.info(`[test:full] ${summary.trim()}`);
		}
	}
	const seconds = (performance.now() - phaseStartedAt) / 1000;
	timings.push({ phase, seconds });
	console.info(`[test:full] ${phase} completed in ${seconds.toFixed(1)}s`);
}

const totalSeconds = (performance.now() - startedAt) / 1000;
console.info(`[test:full] complete in ${totalSeconds.toFixed(1)}s`);
writeTimingReport(process.env.LEITWERK_TEST_TIMINGS_FILE, timings);
if (process.env.GITHUB_STEP_SUMMARY) {
	appendFileSync(
		process.env.GITHUB_STEP_SUMMARY,
		[
			"## Full validation timings",
			"",
			"| Phase | Duration |",
			"|---|---:|",
			...timings.map(({ phase, seconds }) => `| \`${phase}\` | ${seconds.toFixed(1)}s |`),
			`| **Total** | **${totalSeconds.toFixed(1)}s** |`,
			"",
		].join("\n"),
	);
}
