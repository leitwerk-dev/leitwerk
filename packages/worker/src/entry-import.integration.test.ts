import { execFileSync } from "node:child_process";
import { expect, it } from "vitest";

it("loads worker entry modules before loading the Pi runtime", () => {
	const workerUrl = new URL("../dist/index.js", import.meta.url).href;
	const output = execFileSync(
		process.execPath,
		[
			"--input-type=module",
			"-e",
			`
import { registerHooks } from "node:module";
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith("@earendil-works/")) {
      throw new Error("Pi runtime loaded before worker startup: " + specifier);
    }
    return nextResolve(specifier, context);
  },
});
const worker = await import(${JSON.stringify(workerUrl)});
console.log(typeof worker.createWorkerEntryRuntime);
`,
		],
		{ encoding: "utf8", timeout: 15_000 },
	);
	expect(output.trim()).toBe("function");
});
