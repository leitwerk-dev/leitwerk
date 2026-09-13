import { afterEach, expect, it, vi } from "vitest";
import { createRepositoryBashTool } from "./repository-bash-tool.js";

afterEach(() => vi.unstubAllEnvs());

it("runs repository commands without the service production mode and allows explicit modes", async () => {
	vi.stubEnv("NODE_ENV", "production");
	const tool = await createRepositoryBashTool(process.cwd());
	const result = await tool.execute(
		"environment-regression",
		{
			command: `"${process.execPath}" --input-type=module <<'JS'
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
assert.equal(process.env.NODE_ENV, undefined);
assert.equal(typeof fs.readFileSync, 'function');
assert.equal(typeof os.tmpdir(), 'string');
assert.equal(path.basename('/a/b'), 'b');
console.log('repository environment passed');
JS
NODE_ENV=production "${process.execPath}" -e 'if(process.env.NODE_ENV !== "production") process.exit(1)'`,
		},
		undefined,
		undefined,
		{} as never,
	);
	expect(result.content).toContainEqual({ type: "text", text: "repository environment passed\n" });
	expect(process.env.NODE_ENV).toBe("production");
});
