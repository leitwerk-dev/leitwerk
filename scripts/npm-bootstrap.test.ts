import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
	bootstrapCatalog,
	bootstrapPackages,
	missingPackages,
	needsPublisher,
	publishBootstrap,
	readPublishers,
} from "./npm-bootstrap.mjs";

const catalog = [{ name: "@leitwerk-dev/a" }, { name: "@leitwerk-dev/b" }];

describe("npm bootstrap safety (npm responses are substituted)", () => {
	it("discovers public workspaces without requiring a build", () => {
		const root = mkdtempSync(path.join(tmpdir(), "bootstrap-catalog-"));
		try {
			writeFileSync(
				path.join(root, "package.json"),
				JSON.stringify({ workspaces: ["packages/*"] }),
			);
			for (const name of ["a", "private", "stale"])
				mkdirSync(path.join(root, "packages", name), { recursive: true });
			writeFileSync(path.join(root, "packages/a/package.json"), JSON.stringify(catalog[0]));
			writeFileSync(
				path.join(root, "packages/private/package.json"),
				JSON.stringify({ private: true }),
			);
			expect(bootstrapCatalog(root)).toEqual([catalog[0]]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("registers only absent names, not absent release versions", async () => {
		expect(
			await missingPackages(catalog, async (url: string) =>
				url.endsWith("%2Fa")
					? Response.json({ name: catalog[0].name, versions: { "0.0.0-bootstrap.0": {} } })
					: new Response(null, { status: 404 }),
			),
		).toEqual([catalog[1].name]);
		for (const response of [new Response(null, { status: 403 }), Response.json({})])
			await expect(missingPackages(catalog, async () => response)).rejects.toThrow();
	});

	it.each([0, 1])("isolates placeholder contents and cleans up after npm exits %s", (status) => {
		let directory = "";
		const publish = () =>
			publishBootstrap(
				[catalog[0].name],
				(_command: string, args: string[], options: { cwd: string; stdio: string }) => {
					directory = options.cwd;
					expect(options.stdio).toBe("inherit");
					expect(readdirSync(directory).sort()).toEqual(["README.md", "package.json"]);
					expect(
						JSON.parse(readFileSync(path.join(directory, "package.json"), "utf8")),
					).toMatchObject({
						name: catalog[0].name,
						version: "0.0.0-bootstrap.0",
						publishConfig: {
							tag: "bootstrap",
							access: "public",
							registry: "https://registry.npmjs.org/",
							provenance: false,
						},
					});
					expect(args).toContain("--ignore-scripts");
					return { status };
				},
			);
		if (status === 0) publish();
		else expect(publish).toThrow("rerun to resume");
		expect(existsSync(directory)).toBe(false);
	});

	it("validates all package names before the first write", () => {
		const run = () => {
			throw new Error("must not run");
		};
		expect(() => publishBootstrap([catalog[0].name, "foreign/package"], run)).toThrow(
			"Invalid package name",
		);
		expect(() =>
			bootstrapPackages([...catalog, { name: "foreign/package" }], [catalog[0].name], run),
		).toThrow("Invalid package name");
	});

	it("streams every npm command directly and leaves publisher confirmation to npm", () => {
		const calls: string[][] = [];
		bootstrapPackages(
			catalog,
			[catalog[1].name],
			(command: string, args: string[], options: { stdio: string }) => {
				expect(command).toBe("npm");
				expect(options.stdio).toBe("inherit");
				calls.push(args);
				return {
					status: 0,
					get stdout(): never {
						throw new Error("npm output must not be read");
					},
				};
			},
			() => [],
		);
		expect(calls[0][0]).toBe("publish");
		expect(calls.slice(1)).toEqual(
			catalog.map(({ name }) => [
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
				"--registry",
				"https://registry.npmjs.org/",
			]),
		);
	});

	it.each([1, null])("stops when npm trust exits unsuccessfully (%s)", (status) => {
		const calls: string[][] = [];
		expect(() =>
			bootstrapPackages(
				catalog,
				[],
				(_command: string, args: string[]) => {
					calls.push(args);
					return { status };
				},
				() => [],
			),
		).toThrow("rerun bootstrap to resume");
		expect(calls).toHaveLength(1);
	});

	it("skips matching publishers, rejects conflicts before writes, and resumes partial setup", () => {
		const publisher = {
			type: "github",
			claims: {
				repository: "leitwerk-dev/leitwerk",
				workflow_ref: { file: "publish.yml" },
				environment: "npm-publish",
			},
			permissions: ["createPackage", "createStagedPackage"],
		};
		const configured = new Map<string, unknown[]>([[catalog[0].name, [publisher]]]);
		const writes: string[] = [];
		const lookup = (name: string) => configured.get(name) ?? [];
		let fail = true;
		const run = (_command: string, args: string[]) => {
			writes.push(args[2]);
			if (fail) return { status: 1 };
			configured.set(args[2], [publisher]);
			return { status: 0 };
		};
		configured.set(catalog[1].name, [{ ...publisher, type: "gitlab" }]);
		expect(() => bootstrapPackages(catalog, [], run, lookup)).toThrow("Conflicting");
		expect(writes).toEqual([]);
		configured.delete(catalog[1].name);
		expect(() => bootstrapPackages(catalog, [], run, lookup)).toThrow("rerun");
		fail = false;
		bootstrapPackages(catalog, [], run, lookup);
		expect(writes).toEqual([catalog[1].name, catalog[1].name]);
		writes.length = 0;
		bootstrapPackages(catalog, [], run, lookup);
		expect(writes).toEqual([]);
		for (const invalid of [null, [{}], [publisher, publisher], [{ ...publisher, permissions: [] }]])
			expect(() => needsPublisher(invalid, catalog[0].name)).toThrow();
	});

	it("reads only the dedicated JSON channel and rejects failed or invalid lookups", () => {
		const name = catalog[0].name;
		const run = (_command: string, _args: string[], options: { stdio: string[] }) => {
			expect(options.stdio).toEqual(["inherit", "inherit", "inherit", "pipe"]);
			return {
				status: 0,
				output: [null, null, null, JSON.stringify({ packageName: name, publishers: [] })],
			};
		};
		expect(readPublishers(name, run, process.execPath)).toEqual([]);
		for (const result of [
			{ status: 1, output: [null, null, null, "{}"] },
			{ status: 0, output: [null, null, null, "notice\n{}"] },
			{ status: 0, output: [null, null, null, ""] },
			{
				status: 0,
				output: [null, null, null, JSON.stringify({ packageName: "wrong", publishers: [] })],
			},
		])
			expect(() => readPublishers(name, () => result, process.execPath)).toThrow();
	});

	it("keeps terminal diagnostics out of the adapter JSON channel", () => {
		const root = mkdtempSync(path.join(tmpdir(), "npm-trust-adapter-"));
		try {
			mkdirSync(path.join(root, "bin"), { recursive: true });
			mkdirSync(path.join(root, "lib/commands/trust"), { recursive: true });
			writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "11.16.0" }));
			writeFileSync(
				path.join(root, "lib/commands/trust/list.js"),
				`module.exports = class { displayResponseBody() {} };`,
			);
			const cli = path.join(root, "bin/npm-cli.js");
			writeFileSync(
				cli,
				`
				console.log('Press ENTER to open in the browser...');
				console.error('npm notice any future diagnostic');
				const List = require('../lib/commands/trust/list.js');
				new List().displayResponseBody({body: [], packageName: process.argv[4]});
			`,
			);
			expect(readPublishers(catalog[0].name, spawnSync, cli)).toEqual([]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports package progress before authentication and after publisher setup", () => {
		const messages: string[] = [];
		bootstrapPackages(
			catalog,
			[],
			(_command: string, args: string[]) => {
				expect(messages.at(-1)).toContain(`${args[2]}: configuring trusted publisher...`);
				return { status: 0 };
			},
			(name: string) => {
				expect(messages.at(-1)).toContain(`${name}: checking trusted publisher...`);
				return [];
			},
			(message: string) => messages.push(message),
		);
		expect(messages).toEqual([
			"[1/2] @leitwerk-dev/a: checking trusted publisher...",
			"[1/2] @leitwerk-dev/a: publisher setup required",
			"[2/2] @leitwerk-dev/b: checking trusted publisher...",
			"[2/2] @leitwerk-dev/b: publisher setup required",
			"[1/2] @leitwerk-dev/a: configuring trusted publisher...",
			"[1/2] @leitwerk-dev/a: publisher configured",
			"[2/2] @leitwerk-dev/b: configuring trusted publisher...",
			"[2/2] @leitwerk-dev/b: publisher configured",
		]);
	});

	it("propagates spawn errors", () => {
		expect(() =>
			bootstrapPackages(
				catalog,
				[],
				() => ({ error: new Error("spawn failed") }),
				() => [],
			),
		).toThrow("spawn failed");
	});
});
