import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it, onTestFinished } from "vitest";

it("reuses identical chart contents despite timestamps, but rejects metadata and template changes", () => {
	const directory = mkdtempSync(path.join(tmpdir(), "leitwerk-existing-chart-"));
	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
	const chart = path.join(directory, "chart");
	mkdirSync(path.join(chart, "templates"), { recursive: true });
	const files = ["Chart.yaml", "values.yaml", "templates/deployment.yaml"];
	for (const file of files) writeFileSync(path.join(chart, file), `original ${file}\n`);
	const pack = (name: string) => {
		const archive = path.join(directory, `${name}.tgz`);
		execFileSync("tar", ["-czf", archive, "-C", chart, "."]);
		return archive;
	};
	const expected = pack("expected");
	utimesSync(path.join(chart, "Chart.yaml"), 0, 0);
	const existing = pack("existing");
	const verify = () =>
		execFileSync("bash", [
			fileURLToPath(new URL("./verify-release-chart.sh", import.meta.url)),
			expected,
			existing,
		]);
	expect(readFileSync(expected).equals(readFileSync(existing))).toBe(false);
	expect(verify).not.toThrow();
	for (const file of files) {
		writeFileSync(path.join(chart, file), `changed ${file}\n`);
		pack("existing");
		expect(verify).toThrow();
		writeFileSync(path.join(chart, file), `original ${file}\n`);
	}
});
