import { readFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parse } from "yaml";

interface ChartVerification {
	chartDir: string;
	version: string;
	gitSha: string;
	serverDigest: string;
	workerDigest: string;
}

export function verifyReleaseChart(input: ChartVerification): string[] {
	const chart = parse(readFileSync(path.join(input.chartDir, "Chart.yaml"), "utf8"));
	const values = parse(readFileSync(path.join(input.chartDir, "values.yaml"), "utf8"));
	const expectedWorker = `ghcr.io/leitwerk-dev/leitwerk-worker-generic@${input.workerDigest}`;
	return [
		[chart.version === input.version, `Chart version must be ${input.version}`],
		[chart.appVersion === input.version, `Chart appVersion must be ${input.version}`],
		[
			chart.annotations?.["leitwerk.dev/git-sha"] === input.gitSha,
			`Chart Git SHA must be ${input.gitSha}`,
		],
		[
			chart.annotations?.["leitwerk.dev/server-image-digest"] === input.serverDigest,
			`Chart server digest must be ${input.serverDigest}`,
		],
		[
			chart.annotations?.["leitwerk.dev/worker-image-digest"] === input.workerDigest,
			`Chart worker digest must be ${input.workerDigest}`,
		],
		[
			values.server?.image?.repository === "ghcr.io/leitwerk-dev/leitwerk-server" &&
				values.server?.image?.digest === input.serverDigest,
			`Chart values must pin the server digest ${input.serverDigest}`,
		],
		[
			values.workerRuntimeProfiles?.generic?.image === expectedWorker,
			`Chart values must pin the worker image ${expectedWorker}`,
		],
	]
		.filter(([valid]) => !valid)
		.map(([, message]) => String(message));
}

function option(name: string) {
	const index = process.argv.indexOf(name);
	const value = index >= 0 ? process.argv[index + 1] : undefined;
	if (!value || value.startsWith("--")) throw new Error(`Missing ${name}`);
	return value;
}

if (process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
	const errors = verifyReleaseChart({
		chartDir: option("--chart-dir"),
		version: option("--version"),
		gitSha: option("--git-sha"),
		serverDigest: option("--server-digest"),
		workerDigest: option("--worker-digest"),
	});
	if (errors.length > 0) {
		console.error(`[release-chart] Validation failed:\n- ${errors.join("\n- ")}`);
		process.exit(1);
	}
	console.info("[release-chart] Immutable coordinates match");
}
