import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	buildMiseSubprocessEnvironment,
	DevelopmentToolPreparationError,
	MiseDevelopmentToolEnvironment,
	normalizeMiseEvidence,
	PINNED_MISE_VERSION,
	validateMiseVersion,
} from "./development-tool-environment.js";

const isolated = {
	runner: "isolated" as const,
	miseCommand: "/usr/local/bin/mise",
	installTimeoutMs: 1_800_000,
	processStorageRoot: "/custom/process",
};

describe("development tool environment", () => {
	it("derives isolated mise paths from the process storage root and removes secrets", () => {
		expect(
			buildMiseSubprocessEnvironment(
				{
					HOME: "/root",
					PATH: "/usr/bin",
					HTTPS_PROXY: "http://proxy",
					OPENAI_API_KEY: "secret",
					LEITWERK_WORKER_CONNECT_TOKEN: "secret",
				},
				isolated,
			),
		).toEqual({
			HOME: "/root",
			PATH: "/usr/bin",
			HTTPS_PROXY: "http://proxy",
			MISE_DATA_DIR: "/custom/process/tooling/mise",
			MISE_INSTALLS_DIR: "/custom/process/tooling/mise/installs",
			MISE_CACHE_DIR: "/custom/process/tooling/mise/cache",
			MISE_STATE_DIR: "/custom/process/tooling/mise/state",
		});
	});

	it("requires the exact pinned release in isolated workers", () => {
		expect(validateMiseVersion(`mise ${PINNED_MISE_VERSION} linux-x64`, "isolated")).toBe(
			PINNED_MISE_VERSION,
		);
		expect(() => validateMiseVersion("mise 2026.8.15 linux-x64", "isolated")).toThrow(
			DevelopmentToolPreparationError,
		);
	});

	it("accepts only newer local releases in the pinned calendar major", () => {
		expect(validateMiseVersion("mise 2026.9.0 macos-arm64", "local")).toBe("2026.9.0");
		expect(() => validateMiseVersion("mise 2026.1.0 macos-arm64", "local")).toThrow();
		expect(() => validateMiseVersion("mise 2027.1.0 macos-arm64", "local")).toThrow();
	});

	it("normalizes and sorts supported current-tool evidence shapes", () => {
		expect(
			normalizeMiseEvidence({
				python: [{ version: "3.13.1", source: { path: ".mise.toml" } }],
				node: "26.3.0",
			}),
		).toEqual([
			{ name: "node", version: "26.3.0" },
			{ name: "python", version: "3.13.1" },
		]);
	});

	it("prepares repository roots sequentially and writes raw diagnostic output", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "leitwerk-mise-test-"));
		const log = path.join(root, "calls.log");
		const command = path.join(root, "mise");
		await Promise.all([
			mkdir(path.join(root, "workspace", "a"), { recursive: true }),
			mkdir(path.join(root, "workspace", "b"), { recursive: true }),
		]);
		await writeFile(
			command,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "mise ${PINNED_MISE_VERSION} linux-x64"; exit 0; fi
echo "$(basename "$PWD"):$1" >> "${log}"
if [ "$1" = "install" ]; then echo lock > mise.lock; echo 'token=unredacted' >&2; exit 0; fi
printf '{"node":"26.3.0"}\\n'
`,
		);
		await chmod(command, 0o755);
		const diagnosticTrace: string[] = [];
		const prepared = await new MiseDevelopmentToolEnvironment({
			HOME: root,
			PATH: "/usr/bin:/bin",
		}).prepare({
			config: { ...isolated, miseCommand: command, processStorageRoot: root },
			repositories: [
				{ repositoryKey: "b", workingDirectory: path.join(root, "workspace", "b") },
				{ repositoryKey: "a", workingDirectory: path.join(root, "workspace", "a") },
			],
			onDiagnosticTrace: (text) => diagnosticTrace.push(text),
		});
		expect(await readFile(log, "utf8")).toBe("a:install\na:ls\nb:install\nb:ls\n");
		expect(diagnosticTrace.join("")).toContain("token=unredacted");
		expect(prepared.repositories.map((repository) => repository.repositoryKey)).toEqual(["a", "b"]);
		expect(prepared.commandEnvironment.PATH?.split(path.delimiter)[0]).toBe(
			path.join(root, "tooling", "mise", "shims"),
		);
		const evidence = JSON.parse(
			await readFile(path.join(root, "tooling", "mise-preparation", "latest.json"), "utf8"),
		);
		expect(evidence.repositories[0].tools).toEqual([{ name: "node", version: "26.3.0" }]);
	});

	it("reuses isolated mise state across replacement environment instances", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "leitwerk-mise-replacement-test-"));
		const repository = path.join(root, "workspace", "repo");
		const command = path.join(root, "mise");
		const log = path.join(root, "reuse.log");
		await mkdir(repository, { recursive: true });
		await writeFile(
			command,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "mise ${PINNED_MISE_VERSION} linux-x64"; exit 0; fi
if [ "$1" = "install" ]; then
  if [ -f "$MISE_STATE_DIR/prepared" ]; then echo warm >> "${log}"; else echo cold >> "${log}"; fi
  touch "$MISE_STATE_DIR/prepared"
  exit 0
fi
printf '{"node":"26.3.0"}\\n'
`,
		);
		await chmod(command, 0o755);
		const input = {
			config: { ...isolated, miseCommand: command, processStorageRoot: root },
			repositories: [{ repositoryKey: "repo", workingDirectory: repository }],
		};

		await new MiseDevelopmentToolEnvironment({ HOME: root, PATH: "/usr/bin:/bin" }).prepare(input);
		await new MiseDevelopmentToolEnvironment({ HOME: root, PATH: "/usr/bin:/bin" }).prepare(input);

		expect(await readFile(log, "utf8")).toBe("cold\nwarm\n");
	});

	it("escalates cancellation to SIGKILL when mise ignores SIGTERM", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "leitwerk-mise-cancel-test-"));
		const repository = path.join(root, "workspace", "repo");
		const command = path.join(root, "mise");
		await mkdir(repository, { recursive: true });
		await writeFile(
			command,
			`#!/bin/sh
if [ "$1" = "--version" ]; then echo "mise ${PINNED_MISE_VERSION} linux-x64"; exit 0; fi
trap '' TERM
echo started
while :; do sleep 1; done
`,
		);
		await chmod(command, 0o755);
		const abort = new AbortController();
		const startedAt = Date.now();
		const preparation = new MiseDevelopmentToolEnvironment({
			HOME: root,
			PATH: "/usr/bin:/bin",
		}).prepare({
			config: { ...isolated, miseCommand: command, processStorageRoot: root },
			repositories: [{ repositoryKey: "repo", workingDirectory: repository }],
			signal: abort.signal,
			onDiagnosticTrace(text) {
				if (text.includes("started")) abort.abort();
			},
		});
		await expect(preparation).rejects.toMatchObject({ code: "cancelled" });
		expect(Date.now() - startedAt).toBeLessThan(5_000);
	}, 10_000);
});
