#!/usr/bin/env node
import { parseArgs } from "node:util";
import { type DevelopmentCommand, runDevelopment } from "./development.js";

try {
	if (process.argv[2] === "api:report") {
		await (await import("./api-report.js")).runApiReportCli(process.argv.slice(3));
	} else if (process.argv[2] === "api:check") {
		(await import("./api-check.js")).runApiCheckCli(process.argv.slice(3));
	} else if (process.argv[2] === "benchmark:worker-startup") {
		await (await import("./benchmark-cli.js")).runBenchmarkCli(process.argv.slice(3));
	} else if (process.argv[2] === "sandbox") {
		const own: Record<string, string> = {};
		const launcherArgs: string[] = [];
		const args = process.argv.slice(3);
		for (let index = 0; index < args.length; index += 1) {
			const match = /^--(workspace|composition)(?:=(.*))?$/.exec(args[index]);
			if (!match) launcherArgs.push(args[index]);
			else own[match[1]] = match[2] ?? args[++index] ?? "";
		}
		await (await import("./sandbox.js")).runSandbox(
			{ workspaceRoot: own.workspace, compositionPath: own.composition },
			launcherArgs,
		);
	} else {
		const { values, positionals } = parseArgs({
			allowPositionals: true,
			options: {
				help: { type: "boolean", short: "h" },
				workspace: { type: "string" },
				composition: { type: "string" },
				checkout: { type: "string" },
				repository: { type: "string" },
				revision: { type: "string" },
			},
		});
		if (values.help || positionals.length === 0) {
			console.info(`Usage: leitwerk-dev <command> [options]

Commands: dev, build, typecheck, test:full, sandbox, api:check, api:report, core:status, core:use-local, core:use-release, benchmark:worker-startup

sandbox [--sandbox=NAME] [--llm=scripted|real] [--ui-port=N] [--backend-port=N] [reset]
                    Start a manifest-declared sandbox with the local core

--workspace PATH    Extension workspace (default: current directory)
--composition PATH  Composition manifest relative to the workspace
--checkout PATH     Core checkout to select with core:use-local
--repository URL    Repository to clone on first use
--revision REF      Initial revision; defaults to public_git_sha in the release lock

Only core:use-local and core:use-release change dependency selection. Existing checkouts retain their branch and edits.`);
		} else {
			if (positionals.length !== 1) throw new Error("Expected one command; use --help");
			if (
				positionals[0] !== "core:use-local" &&
				(values.checkout || values.repository || values.revision)
			)
				throw new Error("--checkout, --repository and --revision require core:use-local");
			await runDevelopment(positionals[0] as DevelopmentCommand, {
				workspaceRoot: values.workspace,
				compositionPath: values.composition,
				checkout: values.checkout,
				repository: values.repository,
				revision: values.revision,
			});
		}
	}
} catch (error) {
	console.error(error instanceof Error ? error.message : "Development command failed");
	if (!process.exitCode) process.exitCode = 1;
}
