import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
	bootstrapCatalog,
	bootstrapInstructions,
	bootstrapManifest,
	bootstrapPackages,
	missingPackages,
	needsPublisher,
	publishBootstrap,
	terminalCommand,
	trustTranscript,
} from "./npm-bootstrap.mjs";

const catalog = [{ name: "@leitwerk-dev/a" }, { name: "@leitwerk-dev/b" }];

describe("npm registration", () => {
	it("discovers public workspaces, ignoring private packages and stale build directories", () => {
		const root = mkdtempSync(path.join(tmpdir(), "bootstrap-catalog-"));
		try {
			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ workspaces: ["packages/*"] }),
			);
			for (const name of ["a", "private", "stale"])
				mkdirSync(path.join(root, "packages", name), { recursive: true });
			writeFileSync(
				path.join(root, "packages/a/package.json"),
				JSON.stringify({ name: catalog[0].name }),
			);
			writeFileSync(
				path.join(root, "packages/private/package.json"),
				JSON.stringify({ name: "private", private: true }),
			);
			expect(bootstrapCatalog(root)).toEqual([catalog[0]]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("checks package existence, not the proposed release or latest tag", async () => {
		const urls: string[] = [];
		const missing = await missingPackages(catalog, async (url: string) => {
			urls.push(url);
			return url.endsWith("%2Fa")
				? Response.json({ name: catalog[0].name, versions: { "0.0.0-bootstrap.0": {} } })
				: Response.json({ error: "Not found" }, { status: 404 });
		});
		expect(missing).toEqual([catalog[1].name]);
		expect(urls).toEqual(
			catalog.map(({ name }) => `https://registry.npmjs.org/${encodeURIComponent(name)}`),
		);
	});

	it.each([401, 403, 429, 500])("fails closed for HTTP %s", async (status) => {
		await expect(
			missingPackages(catalog, async () => new Response(null, { status })),
		).rejects.toThrow(`HTTP ${status}`);
	});

	it("fails closed for malformed metadata and network failures", async () => {
		await expect(missingPackages(catalog, async () => Response.json({}))).rejects.toThrow(
			"invalid or unpublished",
		);
		await expect(
			missingPackages(catalog, async () => {
				throw new Error("offline");
			}),
		).rejects.toThrow("offline");
	});

	it("publishes only isolated metadata placeholders and cleans temporary files", () => {
		const directories: string[] = [];
		publishBootstrap(
			[catalog[0].name],
			(command: string, args: string[], options: { cwd: string }) => {
				directories.push(options.cwd);
				expect(command).toBe("npm");
				expect(args).toEqual([
					"publish",
					options.cwd,
					"--tag",
					"bootstrap",
					"--access",
					"public",
					"--registry",
					"https://registry.npmjs.org/",
					"--ignore-scripts",
					"--provenance=false",
				]);
				expect(readdirSync(options.cwd).sort()).toEqual(["README.md", "package.json"]);
				expect(JSON.parse(readFileSync(path.join(options.cwd, "package.json"), "utf8"))).toEqual(
					bootstrapManifest(catalog[0].name),
				);
				return { status: 0 };
			},
		);
		expect(directories).toHaveLength(1);
		expect(existsSync(directories[0])).toBe(false);
	});

	it("does no publication when all names exist", () => {
		publishBootstrap([], () => {
			throw new Error("must not run");
		});
	});

	it("stops and cleans up on publish failure", () => {
		const directories: string[] = [];
		expect(() =>
			publishBootstrap(
				catalog.map(({ name }) => name),
				(_command: string, _args: string[], options: { cwd: string }) => {
					directories.push(options.cwd);
					return { status: 1 };
				},
			),
		).toThrow("rerun to resume");
		expect(directories).toHaveLength(1);
		expect(existsSync(directories[0])).toBe(false);
	});

	it("validates all names before publishing", () => {
		expect(() =>
			publishBootstrap([catalog[0].name, "foreign/package"], () => {
				throw new Error("must not run");
			}),
		).toThrow("Invalid package name");
	});

	it("provides the minimal command and distinguishes registration from OIDC configuration", () => {
		const text = bootstrapInstructions([catalog[1].name]);
		expect(text).toContain("npm run publish:bootstrap");
		expect(text).toContain(catalog[1].name);
		expect(text).toContain("publish.yml");
		expect(text).toContain("npm-publish");
		expect(text).toContain("does not verify trusted-publisher settings");
		expect(bootstrapInstructions([])).toContain("All workspace package names are registered");
	});

	it("configures missing publishers, including previously bootstrapped packages", () => {
		const calls: string[][] = [];
		bootstrapPackages(catalog, [catalog[1].name], (_command: string, args: string[]) => {
			calls.push(args);
			return { status: 0, stdout: args[0] === "--version" ? "11.16.0" : "" };
		});
		expect(calls.map((args) => args.slice(0, 2))).toEqual([
			["--version"],
			["trust", "list"],
			["publish", expect.any(String)],
			["trust", "github"],
			["trust", "github"],
		]);
		for (const name of catalog.map((entry) => entry.name)) {
			expect(calls).toContainEqual([
				"trust",
				"github",
				name,
				"--repo",
				"leitwerk-dev/leitwerk",
				"--file",
				"publish.yml",
				"--env",
				"npm-publish",
				"--allow-publish",
				"--yes",
				"--registry",
				"https://registry.npmjs.org/",
			]);
		}
	});

	const publisher = {
		type: "github",
		repository: "leitwerk-dev/leitwerk",
		file: "publish.yml",
		environment: "npm-publish",
		permissions: ["createPackage"],
	};

	it("skips matching publishers on reruns", () => {
		bootstrapPackages(catalog, [], (_command: string, args: string[]) => {
			if (args[0] === "--version") return { status: 0, stdout: "11.16.0" };
			expect(args.slice(0, 2)).toEqual(["trust", "list"]);
			return { status: 0, stdout: JSON.stringify(publisher) };
		});
		expect(needsPublisher("", catalog[0].name)).toBe(true);
	});

	it.each([
		{ type: "gitlab" },
		{ repository: "other/repo" },
		{ file: "publish-rc.yml" },
		{ environment: "npm-prerelease" },
		{ permissions: ["createStagedPackage"] },
	])("rejects conflicting publisher %j before any writes", (change) => {
		expect(() =>
			bootstrapPackages(catalog, [catalog[1].name], (_command: string, args: string[]) => {
				if (args[0] === "--version") return { status: 0, stdout: "11.16.0" };
				expect(args.slice(0, 2)).toEqual(["trust", "list"]);
				return { status: 0, stdout: JSON.stringify({ ...publisher, ...change }) };
			}),
		).toThrow("refusing to overwrite");
	});

	it("requires a supported npm version before any writes", () => {
		expect(() =>
			bootstrapPackages(catalog, [catalog[0].name], (_command: string, args: string[]) => {
				expect(args).toEqual(["--version"]);
				return { status: 0, stdout: "10.9.2" };
			}),
		).toThrow("requires npm 11.16+");
	});

	it("fails closed on trust lookup errors and malformed output", () => {
		expect(() => needsPublisher("not JSON", catalog[0].name)).toThrow();
		expect(() =>
			bootstrapPackages(catalog, [], (_command: string, args: string[]) => {
				if (args[0] === "--version") return { status: 0, stdout: "11.16.0" };
				expect(args.slice(0, 2)).toEqual(["trust", "list"]);
				return { status: 1 };
			}),
		).toThrow("failed; rerun bootstrap");
	});

	it("stops on trust creation failure and can resume without republishing", () => {
		let fail = true;
		const configured = new Set<string>();
		const run = (_command: string, args: string[]) => {
			if (args[0] === "--version") return { status: 0, stdout: "11.16.0" };
			if (args[1] === "list")
				return { status: 0, stdout: configured.has(args[2]) ? JSON.stringify(publisher) : "" };
			expect(args.slice(0, 2)).toEqual(["trust", "github"]);
			if (fail && args[2] === catalog[1].name) return { status: 1 };
			configured.add(args[2]);
			return { status: 0 };
		};
		expect(() => bootstrapPackages(catalog, [], run)).toThrow("rerun bootstrap");
		expect([...configured]).toEqual([catalog[0].name]);
		fail = false;
		bootstrapPackages(catalog, [], run);
		expect([...configured]).toEqual(catalog.map(({ name }) => name));
	});

	it("reads publisher JSON amid terminal framing and browser authentication output", () => {
		const auth = JSON.stringify({
			title: "Authenticate your account at",
			url: "https://example.invalid/auth",
		});
		const output = `Script started\r\n\u001b[32m${JSON.stringify(publisher, null, 2)}\u001b[0m\r\n${auth}\r\nScript done\r\n`;
		expect(JSON.parse(trustTranscript(output))).toEqual(publisher);
		expect(trustTranscript(`Script started\r\n${auth}\r\nScript done`)).toBe("");
		expect(() => trustTranscript('{"type":')).toThrow("Incomplete");
		expect(() => trustTranscript("{broken}")).toThrow();
		expect(() =>
			trustTranscript(`${JSON.stringify(publisher)}\n${JSON.stringify(publisher)}`),
		).toThrow("multiple");
	});

	it.each([
		"darwin",
		"linux",
	])("captures trust output through a private terminal on %s", (platform) => {
		let transcript = "";
		const result = terminalCommand(
			"npm",
			["trust", "list", catalog[0].name, "--json"],
			{ stdio: ["inherit", "pipe", "inherit"] },
			(command: string, args: string[], options: { stdio: string }) => {
				expect(command).toBe("script");
				expect(options.stdio).toBe("inherit");
				transcript = platform === "darwin" ? args[1] : args[args.length - 1];
				expect(statSync(path.dirname(transcript)).mode & 0o777).toBe(0o700);
				if (platform === "linux") {
					expect(args.slice(0, 3)).toEqual(["-q", "-e", "-c"]);
					expect(args[3]).toContain("'npm' 'trust' 'list'");
				} else expect(args.slice(2, 5)).toEqual(["npm", "trust", "list"]);
				writeFileSync(transcript, JSON.stringify(publisher));
				return { status: 0 };
			},
			platform,
		);
		expect(JSON.parse(result.stdout)).toEqual(publisher);
		expect(existsSync(path.dirname(transcript))).toBe(false);
	});

	it("preserves child failure and removes the authentication transcript", () => {
		let transcript = "";
		const result = terminalCommand(
			"npm",
			["trust", "list"],
			{ stdio: ["inherit", "pipe", "inherit"] },
			(_command: string, args: string[]) => {
				transcript = args[1];
				writeFileSync(transcript, "authentication failed");
				return { status: 1 };
			},
			"darwin",
		);
		expect(result.status).toBe(1);
		expect(result.stdout).toBe("");
		expect(existsSync(path.dirname(transcript))).toBe(false);
	});

	it("gives the real child a terminal for both stdin and stdout", () => {
		const result = terminalCommand(
			process.execPath,
			[
				"-e",
				"console.log(JSON.stringify(Object.fromEntries(['stdin','stdout'].map(k=>[k,process[k].isTTY])))); if (!process.stdin.isTTY || !process.stdout.isTTY) process.exit(9)",
			],
			{ stdio: ["inherit", "pipe", "inherit"] },
			(command: string, args: string[]) =>
				spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }),
		);
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ stdin: true, stdout: true });
	});

	it("runs the read-only check on release PRs without credentials or installation", () => {
		const workflow = parse(
			readFileSync(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8"),
		);
		const job = workflow.jobs["npm-registration"];
		expect(job.if).toContain("github.event_name == 'pull_request'");
		expect(job.if).toContain("release-please--branches--main");
		expect(
			job.steps
				.filter((step: { run?: string }) => step.run)
				.map((step: { run: string }) => step.run),
		).toEqual(["npm run publish:registration"]);
		expect(job.environment).toBeUndefined();
		expect(workflow.permissions).toEqual({ contents: "read" });
	});
});
