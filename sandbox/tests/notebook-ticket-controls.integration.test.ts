import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { expect, it, onTestFinished } from "vitest";
import notebookComposition from "../composition.js";

it("serves a persisted local ticket receipt without starting a process or worker", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "notebook-receipt-"));
	const app = Fastify();
	onTestFinished(async () => {
		await app.close();
		await rm(root, { recursive: true, force: true });
	});
	const url = "http://127.0.0.1:18082/__local/tickets/1";
	await writeFile(
		path.join(root, "tickets.json"),
		JSON.stringify({
			version: 1,
			failAfterPersistence: false,
			tickets: [
				{
					id: "1",
					writeKey: "receipt-key",
					destinationId: "garden",
					title: "Review garden",
					body: "Record watering dates.",
					url,
				},
			],
		}),
	);
	const composition = notebookComposition({
		paths: { workspaceRoot: root, root, directory: root },
		mode: "scripted",
		urls: { backend: "http://127.0.0.1:18082", ui: "http://127.0.0.1:19173" },
		modelProfileId: "sandbox",
	});
	// Notebook control registration only needs Fastify, not the application runtime.
	await composition.registerControls?.({ app } as never);
	const response = await app.inject(new URL(url).pathname);
	expect(response.statusCode).toBe(200);
	expect(response.body).toBe("Review garden\n\nRecord watering dates.");
	expect((await app.inject("/__local/tickets/missing")).statusCode).toBe(404);
});
