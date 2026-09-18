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
import {
	bootstrapCatalog,
	bootstrapPackages,
	missingPackages,
	needsPublisher,
	publishBootstrap,
	terminalCommand,
	trustTranscript,
} from "./npm-bootstrap.mjs";

const catalog = [{ name: "@leitwerk-dev/a" }, { name: "@leitwerk-dev/b" }];
const publisher = {
	type: "github",
	repository: "leitwerk-dev/leitwerk",
	file: "publish.yml",
	environment: "npm-publish",
	permissions: ["createPackage"],
};

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
				(_command: string, args: string[], options: { cwd: string }) => {
					directory = options.cwd;
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
		let writes = 0;
		expect(() =>
			publishBootstrap([catalog[0].name, "foreign/package"], () => {
				writes++;
				return { status: 0 };
			}),
		).toThrow("Invalid package name");
		expect(writes).toBe(0);
	});

	it("checks conflicts before writes and resumes interrupted trust creation", () => {
		const configured = new Map<string, typeof publisher>([
			[catalog[1].name, { ...publisher, file: "other.yml" }],
		]);
		const writes: string[] = [];
		let fail = true;
		const run = (_command: string, args: string[]) => {
			if (args[0] === "--version") return { status: 0, stdout: "11.16.0" };
			if (args[1] === "list")
				return {
					status: 0,
					stdout: configured.has(args[2]) ? JSON.stringify(configured.get(args[2])) : "",
				};
			writes.push(args[2]);
			if (fail && args[2] === catalog[1].name) return { status: 1 };
			configured.set(args[2], publisher);
			return { status: 0 };
		};
		expect(() => bootstrapPackages(catalog, [], run)).toThrow("refusing to overwrite");
		expect(writes).toEqual([]);
		configured.clear();
		expect(() => bootstrapPackages(catalog, [], run)).toThrow("rerun bootstrap");
		expect([...configured.keys()]).toEqual([catalog[0].name]);
		writes.length = 0;
		fail = false;
		bootstrapPackages(catalog, [], run);
		expect(writes).toEqual([catalog[1].name]);
		expect([...configured.keys()]).toEqual(catalog.map(({ name }) => name));
	});

	it("distinguishes known terminal/auth framing from malformed trust output", () => {
		// Synthetic npm 11.16 protocol examples, not evidence of live authentication.
		const auth = JSON.stringify({
			title: "Authenticate your account at",
			url: "https://example.invalid/auth",
		});
		const frame = (body: string) =>
			`Script started on example\r\n${body}\r\nScript done on example\r\n`;
		expect(
			needsPublisher(
				trustTranscript(frame(`${auth}\nPress ENTER to open in the browser...`)),
				catalog[0].name,
			),
		).toBe(true);
		expect(
			needsPublisher(
				trustTranscript(frame(`\u001b[32m${JSON.stringify(publisher)}\u001b[0m`)),
				catalog[0].name,
			),
		).toBe(false);
		for (const malformed of [
			"not JSON",
			'{"type":',
			"{broken}",
			`${JSON.stringify(publisher)}\n${JSON.stringify(publisher)}`,
		])
			expect(() => needsPublisher(trustTranscript(frame(malformed)), catalog[0].name)).toThrow();
	});
});

describe("real terminal adapter", () => {
	it.each([0, 9])("provides a terminal and preserves child exit %s", (status) => {
		let transcript = "";
		const result = terminalCommand(
			process.execPath,
			[
				"-e",
				`console.log(JSON.stringify({stdin:process.stdin.isTTY,stdout:process.stdout.isTTY}));process.exit(${status})`,
			],
			{ stdio: ["inherit", "pipe", "inherit"] },
			(command: string, args: string[]) => {
				transcript = process.platform === "darwin" ? args[1] : args[args.length - 1];
				expect(statSync(path.dirname(transcript)).mode & 0o777).toBe(0o700);
				return spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 });
			},
		);
		expect(result.status).toBe(status);
		if (status === 0) expect(JSON.parse(result.stdout)).toEqual({ stdin: true, stdout: true });
		else expect(result.stdout).toBe("");
		expect(existsSync(path.dirname(transcript))).toBe(false);
	});
});
