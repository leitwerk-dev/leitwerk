import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, onTestFinished } from "vitest";
import { validationEnvironment } from "./validation-environment.js";

function executableDirectory() {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-validation-git-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	writeFileSync(path.join(directory, "git"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
	return directory;
}

it("resolves Apple's launcher once and preserves the caller's environment", () => {
	const directory = executableDirectory();
	const env = { PATH: "/usr/bin:/bin", DEVELOPER_DIR: "/selected/xcode", SENTINEL: "retained" };
	let calls = 0;
	const resolve = () => {
		calls++;
		return path.join(directory, "git");
	};
	const result = validationEnvironment(env, "darwin", resolve);
	expect(result).toEqual({ ...env, PATH: `${directory}:/usr/bin:/bin` });
	expect(env.PATH).toBe("/usr/bin:/bin");
	expect(validationEnvironment(result, "darwin", resolve)).toEqual(result);
	expect(calls).toBe(1);
});

it("does not replace a caller's explicit Git or consult Xcode on Linux", () => {
	const directory = executableDirectory();
	const resolve = () => {
		throw new Error("Developer tools must not be consulted");
	};
	for (const platform of ["linux", "darwin"] as const) {
		const env = { PATH: `${directory}:/usr/bin:/bin` };
		expect(validationEnvironment(env, platform, resolve)).toEqual(env);
	}
	expect(validationEnvironment({ PATH: "/usr/bin:/bin" }, "linux", resolve)).toEqual({
		PATH: "/usr/bin:/bin",
	});
});

it("follows a PATH symlink to the Apple launcher", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-validation-launcher-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	symlinkSync("/usr/bin/git", path.join(directory, "git"));
	const developer = executableDirectory();
	expect(
		validationEnvironment({ PATH: directory }, "darwin", () => path.join(developer, "git")),
	).toEqual({ PATH: `${developer}:${directory}` });
});

it.each([
	"",
	"git",
	"/usr/bin/git",
	"/missing/developer/git",
])("rejects an unusable developer Git resolution: %s", (git) => {
	expect(() => validationEnvironment({ PATH: "/usr/bin" }, "darwin", () => git)).toThrow(
		"xcrun did not resolve",
	);
});
