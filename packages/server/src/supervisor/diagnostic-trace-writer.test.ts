import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDiagnosticTraceWriter } from "./diagnostic-trace-writer.js";

describe("diagnostic trace writer", () => {
	it("appends worker trace text verbatim to a private process log", async () => {
		const root = await mkdtemp(path.join(tmpdir(), "leitwerk-diagnostic-trace-"));
		const writer = createDiagnosticTraceWriter(root);
		writer.append("agt_1", "token=unredacted\n");
		writer.append("agt_1", "next chunk\n");

		const file = path.join(root, "agt_1.log");
		expect(await readFile(file, "utf8")).toBe("token=unredacted\nnext chunk\n");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
	});
});
