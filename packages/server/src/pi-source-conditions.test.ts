import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

it("uses published Pi imports while retaining source exports for Leitwerk", () => {
	const root = mkdtempSync(path.join(tmpdir(), "pi-source-conditions-"));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	for (const scope of ["@earendil-works", "@leitwerk-dev"]) {
		const directory = path.join(root, "node_modules", scope, "fixture");
		mkdirSync(directory, { recursive: true });
		writeFileSync(
			path.join(directory, "package.json"),
			JSON.stringify({
				type: "module",
				exports: { source: "./source.js", import: "./published.js" },
			}),
		);
		writeFileSync(path.join(directory, "published.js"), 'export default "published";');
		if (scope === "@leitwerk-dev") {
			writeFileSync(path.join(directory, "source.js"), 'export default "source";');
		}
	}
	const result = spawnSync(
		process.execPath,
		[
			"--conditions=source",
			"--import",
			fileURLToPath(new URL("../../../scripts/pi-source-conditions.mjs", import.meta.url)),
			"--input-type=module",
			"--eval",
			'import pi from "@earendil-works/fixture"; import core from "@leitwerk-dev/fixture"; console.log(JSON.stringify({ pi, core }));',
		],
		{ cwd: root, encoding: "utf8" },
	);
	expect(result.status, result.stderr).toBe(0);
	expect(JSON.parse(result.stdout)).toEqual({ pi: "published", core: "source" });
});
