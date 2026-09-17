import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { isUnknownRecord } from "@leitwerk-dev/domain";
import { runWorkerStartupBenchmark } from "./benchmark.js";

export async function runBenchmarkCli(args: string[]): Promise<void> {
	const { values } = parseArgs({
		args,
		options: {
			help: { type: "boolean", short: "h" },
			"api-config": { type: "string", default: ".leitwerk/api/leitwerk.yaml" },
			launcher: { type: "string" },
			"model-profile": { type: "string" },
			input: { type: "string" },
			title: { type: "string" },
			candidate: { type: "string" },
			output: { type: "string" },
			samples: { type: "string" },
			warmups: { type: "string" },
			"timeout-ms": { type: "string" },
			"poll-interval-ms": { type: "string" },
			namespace: { type: "string" },
			deployment: { type: "string" },
			kubeconfig: { type: "string" },
			"expected-server-image": { type: "string" },
		},
	});
	if (values.help) {
		console.info(`Usage: leitwerk-dev benchmark:worker-startup --launcher ID --model-profile ID --input FILE --title TEXT --candidate LABEL --output NEW_DIRECTORY

--api-config FILE         YAML containing base_url and api_token (default: .leitwerk/api/leitwerk.yaml)
--samples COUNT           Measured launches (default: 30)
--warmups COUNT           Separate warm-up launches (default: 0)
--timeout-ms MS           Per-launch deadline (default: 180000)
--poll-interval-ms MS     Polling interval (default: 500)

Optional read-only Kubernetes evidence:
--namespace NAME --deployment NAME [--kubeconfig FILE] [--expected-server-image IMAGE]

Input is a JSON object for the selected launcher. Existing output directories are rejected.
The benchmark retains processes and raw evidence. A timeout or uncertain API outcome stops further launches.`);
		return;
	}
	const required = (
		name: "launcher" | "model-profile" | "input" | "title" | "candidate" | "output",
	) => {
		const value = values[name];
		if (!value?.trim()) throw new Error(`Explicit --${name} is required`);
		return value;
	};
	const inputPath = required("input");
	let launcherInput: unknown;
	try {
		launcherInput = JSON.parse(readFileSync(inputPath, "utf8"));
	} catch {
		throw new Error("Cannot read launcher input as JSON");
	}
	if (!isUnknownRecord(launcherInput)) throw new Error("Launcher input must be a JSON object");
	const withKubernetes = !!(
		values.namespace ||
		values.deployment ||
		values.kubeconfig ||
		values["expected-server-image"]
	);
	if (withKubernetes && (!values.namespace || !values.deployment))
		throw new Error("Kubernetes evidence requires --namespace and --deployment");
	const controller = new AbortController();
	let interruptionCode: number | undefined;
	const interrupt = () => {
		interruptionCode = 130;
		controller.abort();
	};
	const terminate = () => {
		interruptionCode = 143;
		controller.abort();
	};
	process.once("SIGINT", interrupt);
	process.once("SIGTERM", terminate);
	try {
		const result = await runWorkerStartupBenchmark({
			apiConfig: values["api-config"],
			launcherId: required("launcher"),
			modelProfileId: required("model-profile"),
			title: required("title"),
			candidate: required("candidate"),
			output: required("output"),
			launcherInput,
			samples: values.samples === undefined ? undefined : Number(values.samples),
			warmups: values.warmups === undefined ? undefined : Number(values.warmups),
			timeoutMs: values["timeout-ms"] === undefined ? undefined : Number(values["timeout-ms"]),
			pollIntervalMs:
				values["poll-interval-ms"] === undefined ? undefined : Number(values["poll-interval-ms"]),
			kubernetes: withKubernetes
				? {
						namespace: values.namespace as string,
						deployment: values.deployment as string,
						kubeconfig: values.kubeconfig,
						expectedServerImage: values["expected-server-image"],
					}
				: undefined,
			signal: controller.signal,
		});
		console.info(`Report: ${result.reportPath}`);
		if (!result.complete)
			console.error(
				"Benchmark incomplete. Resolve the retained launch before starting another run.",
			);
		else if (!result.succeeded)
			console.error("Benchmark finished with failed launches; inspect the retained report.");
		if (!result.succeeded || interruptionCode) process.exitCode = interruptionCode ?? 1;
	} finally {
		process.off("SIGINT", interrupt);
		process.off("SIGTERM", terminate);
	}
}
