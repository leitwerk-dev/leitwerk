import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import process from "node:process";
import { activateDevelopmentComposition } from "./development-composition.ts";

const npm = process.platform === "win32" ? "npm.cmd" : "npm";
activateDevelopmentComposition(process.cwd());
const phases = [
	"lint",
	"parity:build",
	"test:server-start",
	"test:default-worker",
	"check:boundaries",
	"check:core-integrations",
	"release:check",
	"typecheck",
	"test:parity:built",
	"test:unit",
	"test:integration",
	"test:e2e",
	"test:browser",
];

const startedAt = performance.now();
const timings: Array<{ phase: string; seconds: number }> = [];
for (const phase of phases) {
	console.info(`[test:full] ${phase}`);
	const phaseStartedAt = performance.now();
	const result = spawnSync(npm, ["run", "--silent", phase], {
		cwd: process.cwd(),
		env: {
			...process.env,
			TURBO_DISABLE_UPDATE_CHECK: "1",
			NODE_OPTIONS: [process.env.NODE_OPTIONS, "--no-deprecation"].filter(Boolean).join(" "),
		},
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	if (result.status !== 0) process.exit(result.status ?? 1);
	const seconds = (performance.now() - phaseStartedAt) / 1000;
	timings.push({ phase, seconds });
	console.info(`[test:full] ${phase} completed in ${seconds.toFixed(1)}s`);
}

const totalSeconds = (performance.now() - startedAt) / 1000;
console.info(`[test:full] complete in ${totalSeconds.toFixed(1)}s`);
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
