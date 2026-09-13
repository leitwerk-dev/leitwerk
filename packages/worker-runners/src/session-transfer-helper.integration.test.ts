import { execFile } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { SESSION_TRANSFER_HELPER_ENTRY_PATH } from "./session-transfer-helper.js";

const run = promisify(execFile);
const entry = fileURLToPath(
	new URL(`../dist/${SESSION_TRANSFER_HELPER_ENTRY_PATH.split("/").at(-1)}`, import.meta.url),
);
const options = { env: {}, timeout: 5_000 };

describe("bundled session transfer helper", () => {
	it("fails when launched without required configuration", async () => {
		await expect(run(process.execPath, [entry], options)).rejects.toMatchObject({ code: 1 });
	});

	it("requests its export spec and fails when the server rejects it", async () => {
		const requests: Array<{ method?: string; url?: string; authorization?: string }> = [];
		const server = createServer((request, response) => {
			requests.push({
				method: request.method,
				url: request.url,
				authorization: request.headers.authorization,
			});
			response.writeHead(404).end();
		});
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		try {
			const address = server.address();
			if (!address || typeof address === "string") throw new Error("Missing server address");
			const env = {
				LEITWERK_EXPORT_SERVER_URL: `http://127.0.0.1:${address.port}`,
				LEITWERK_EXPORT_ID: "exp_test",
				LEITWERK_EXPORT_CREDENTIAL: "test-export-credential",
			};
			await expect(run(process.execPath, [entry], { ...options, env })).rejects.toMatchObject({
				code: 1,
			});
			expect(requests).toEqual([
				{
					method: "GET",
					url: "/internal/session-transfer-exports/exp_test/spec",
					authorization: "Bearer test-export-credential",
				},
			]);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) =>
				server.close((error) => (error ? reject(error) : resolve())),
			);
		}
	});

	it("imports the bundled library without starting the CLI", async () => {
		const moduleUrl = new URL("../dist/session-transfer-helper.js", import.meta.url).href;
		const result = await run(
			process.execPath,
			["--input-type=module", "-e", `await import(${JSON.stringify(moduleUrl)})`],
			options,
		);
		expect(result).toMatchObject({ stdout: "", stderr: "" });
	});
});
