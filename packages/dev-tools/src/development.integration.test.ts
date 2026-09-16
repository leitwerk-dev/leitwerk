import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testWorkspace } from "../test-workspace.js";
import { runDevelopment } from "./index.js";
import { packageDirectory, readJson } from "./workspace.js";

beforeEach(() =>
	vi.stubEnv("PATH", `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH}`),
);
afterEach(() => vi.unstubAllEnvs());
function fixture() {
	const { root, json } = testWorkspace();
	json("package.json", {
		name: "example-workspace",
		version: "1.0.0",
		private: true,
		workspaces: ["extensions/*"],
	});
	json("extensions/example/package.json", { name: "example-extension", version: "1.0.0" });
	writeFileSync(
		path.join(root, "leitwerk.composition.yaml"),
		"version: 1\nruntime_config: ./leitwerk.yaml\nextensions: [./extensions/example]\n",
	);
	writeFileSync(path.join(root, "leitwerk.yaml"), "{}\n");
	return { root, json, options: { workspaceRoot: root } };
}
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

describe("extension development commands", () => {
	it.each([
		".",
		"..",
		"@example/..",
		"@../example",
		"../outside",
	])("rejects package name %s before building or changing dependency links", async (name) => {
		const { root, json, options } = fixture();
		json("extensions/example/package.json", {
			name,
			scripts: { build: "node build.cjs" },
		});
		writeFileSync(
			path.join(root, "extensions/example/build.cjs"),
			"require('node:fs').writeFileSync('unexpected-build', 'built')",
		);
		json("node_modules/retained/package.json", { name: "retained" });
		await expect(runDevelopment("build", options)).rejects.toThrow("valid package name");
		expect(existsSync(path.join(root, "extensions/example/unexpected-build"))).toBe(false);
		expect(existsSync(path.join(root, "node_modules/retained/package.json"))).toBe(true);
		expect(existsSync(path.join(root, ".leitwerk/development.json"))).toBe(false);
	});

	it("uses installed packages with an unrelated retained checkout and hidden package metadata", async () => {
		const { root, json, options } = fixture();
		json("package.json", {
			private: true,
			workspaces: ["extensions/*"],
			devDependencies: { "@leitwerk-dev/example-sdk": "1.0.0" },
		});
		json("node_modules/@leitwerk-dev/example-sdk/package.json", {
			name: "@leitwerk-dev/example-sdk",
			exports: { ".": "./index.js" },
		});
		mkdirSync(path.join(root, ".leitwerk-base"));
		await runDevelopment("core:status", options);
		expect(packageDirectory("@leitwerk-dev/example-sdk", root)).toBe(
			path.join(root, "node_modules/@leitwerk-dev/example-sdk"),
		);
		expect(existsSync(path.join(root, ".leitwerk/development.json"))).toBe(false);
		expect(existsSync(path.join(root, ".leitwerk-base/.git"))).toBe(false);
	});

	it("rejects interrupted selections and source links in release mode", async () => {
		const { root, json, options } = fixture();
		json(".leitwerk/development.json", { mode: "switching" });
		await expect(runDevelopment("build", options)).rejects.toThrow("did not finish");
		json(".leitwerk/development.json", { mode: "release" });
		json("package.json", { devDependencies: { "@leitwerk-dev/example-sdk": "1.0.0" } });
		json("sdk/package.json", { name: "@leitwerk-dev/example-sdk" });
		mkdirSync(path.join(root, "node_modules/@leitwerk-dev"), { recursive: true });
		symlinkSync(path.join(root, "sdk"), path.join(root, "node_modules/@leitwerk-dev/example-sdk"));
		await expect(runDevelopment("build", options)).rejects.toThrow(
			"linked to source in release mode",
		);
	});

	it("builds workspace dependencies before consumers, including literal and object workspace patterns", async () => {
		const { root, json, options } = fixture();
		json("package.json", { workspaces: { packages: ["extensions/*", "shared"] } });
		json("extensions/example/package.json", {
			name: "example",
			dependencies: { shared: "*" },
			scripts: { build: "node build.cjs" },
		});
		json("shared/package.json", { name: "shared", scripts: { build: "node build.cjs" } });
		const record = path.join(root, "order.jsonl");
		for (const [dir, label] of [
			["extensions/example", "example"],
			["shared", "shared"],
		])
			writeFileSync(
				path.join(root, dir, "build.cjs"),
				`require('node:fs').appendFileSync(${JSON.stringify(record)}, ${JSON.stringify(`${label}\n`)})`,
			);
		await runDevelopment("build", options);
		expect(readFileSync(record, "utf8")).toBe("shared\nexample\n");
		expect(existsSync(path.join(root, ".leitwerk-base"))).toBe(false);
	});

	it("clones an explicit revision, preserves branches and edits on reuse, then restores release dependencies", async () => {
		const { root, json, options } = fixture();
		json("seed/package.json", {
			name: "core-fixture",
			version: "1.0.0",
			private: true,
			workspaces: ["packages/*"],
			scripts: { build: 'node -e ""' },
		});
		json("seed/packages/sdk/package.json", { name: "@leitwerk-dev/example-sdk", version: "1.0.0" });
		for (const [directory, packageDir] of [
			[".", "extensions/example"],
			["seed", "packages/sdk"],
		]) {
			const { name, version, workspaces } = readJson(path.join(root, directory, "package.json"));
			const workspace = readJson(path.join(root, directory, packageDir, "package.json"));
			json(path.join(directory, "package-lock.json"), {
				name,
				version,
				lockfileVersion: 3,
				packages: {
					"": { name, version, workspaces },
					[packageDir]: { name: workspace.name, version: workspace.version },
					[`node_modules/${workspace.name}`]: { resolved: packageDir, link: true },
				},
			});
		}
		const seed = path.join(root, "seed");
		writeFileSync(path.join(seed, "README.md"), "original\n");
		git(seed, "init");
		git(seed, "add", ".");
		git(
			seed,
			"-c",
			"user.name=Development Test",
			"-c",
			"user.email=test@example.test",
			"-c",
			"commit.gpgsign=false",
			"commit",
			"-s",
			"-m",
			"fixture",
		);
		const revision = git(seed, "rev-parse", "HEAD");
		const before = readFileSync(path.join(root, "package-lock.json"), "utf8");
		const selection = { ...options, repository: seed, revision, checkout: "core-source" };
		await runDevelopment("core:use-local", selection);
		const checkout = path.join(root, "core-source");
		expect(git(checkout, "rev-parse", "HEAD")).toBe(revision);
		git(checkout, "switch", "-c", "task/retained");
		writeFileSync(path.join(checkout, "README.md"), "retained edit\n");
		await runDevelopment("core:use-local", options);
		expect(git(checkout, "branch", "--show-current")).toBe("task/retained");
		await runDevelopment("core:status", options);
		expect(
			packageDirectory("@leitwerk-dev/example-sdk", path.join(root, "extensions/example")),
		).toBe(path.join(checkout, "packages/sdk"));
		writeFileSync(path.join(root, "package-lock.json"), `${before}\n`);
		await expect(runDevelopment("build", options)).rejects.toThrow("Dependencies changed");
		writeFileSync(path.join(root, "package-lock.json"), before);
		await runDevelopment("core:use-release", options);
		await runDevelopment("core:status", options);
		expect(readFileSync(path.join(checkout, "README.md"), "utf8")).toBe("retained edit\n");
		expect(git(checkout, "branch", "--show-current")).toBe("task/retained");
		expect(existsSync(path.join(root, "node_modules/@leitwerk-dev/example-sdk"))).toBe(false);
		expect(
			existsSync(path.join(root, "extensions/example/node_modules/@leitwerk-dev/example-sdk")),
		).toBe(false);
		expect(readFileSync(path.join(root, "package-lock.json"), "utf8")).toBe(before);
	}, 30_000);
});
