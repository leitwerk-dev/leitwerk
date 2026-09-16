import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";

export function testWorkspace() {
	const root = realpathSync(mkdtempSync(path.join(tmpdir(), "leitwerk-dev-tools-")));
	onTestFinished(() => rmSync(root, { recursive: true, force: true }));
	const json = (file: string, value: unknown) => {
		const target = path.resolve(root, file);
		mkdirSync(path.dirname(target), { recursive: true });
		writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`);
	};
	return { root, json };
}
