import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUploadResultImagesTool } from "./result-image-upload.js";

const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 0]);

function workspace(): string {
	return mkdtempSync(path.join(tmpdir(), "leitwerk-result-images-test-"));
}
function success(imageId: string): Response {
	return Response.json(
		{
			imageId,
			url: `/api/processes/p/turn-records/t/result-images/${imageId}`,
			mimeType: "image/png",
			byteSize: PNG.length,
		},
		{ status: 201 },
	);
}
function tool(
	root: string,
	fetchImpl: typeof fetch,
	overrides: Partial<Parameters<typeof createUploadResultImagesTool>[0]> = {},
) {
	return createUploadResultImagesTool({
		workspaceRoot: root,
		instanceId: "p",
		turnRecordId: "t",
		workerId: "w",
		serverUrl: "http://localhost",
		token: "secret",
		maxSizeBytes: 100,
		fetchImpl,
		sleepImpl: async () => {},
		...overrides,
	});
}

describe("upload_result_images", () => {
	it("preserves input order and combines successful snippets", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "a.png"), PNG);
		mkdirSync(path.join(root, "..screenshots"));
		writeFileSync(path.join(root, "..screenshots", "b.png"), PNG);
		let calls = 0;
		const fetchImpl = vi.fn(async () => success(`img_${++calls}`)) as unknown as typeof fetch;
		const result = (await tool(root, fetchImpl).execute({
			images: [
				{ path: "a.png", alt: "First" },
				{ path: "..screenshots/b.png", alt: "Second" },
			],
		})) as { code: string; data: { images: Array<{ path: string }>; markdown: string } };
		expect(result.code).toBe("result_images_uploaded");
		expect(result.data.images.map((entry) => entry.path)).toEqual(["a.png", "..screenshots/b.png"]);
		expect(result.data.markdown).toContain("![First]");
		expect(result.data.markdown.indexOf("![First]")).toBeLessThan(
			result.data.markdown.indexOf("![Second]"),
		);
	});

	it("retries a server error once with the same image body", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "retry.png"), PNG);
		const sleepImpl = vi.fn(async () => {});
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 503 }))
			.mockResolvedValueOnce(success("img_retry")) as unknown as typeof fetch;

		const result = (await tool(root, fetchImpl, { sleepImpl }).execute({
			images: [{ path: "retry.png", alt: "Retry" }],
		})) as { ok: boolean; code: string; data: { markdown: string } };
		const firstRequest = fetchImpl.mock.calls[0]?.[1];
		const retryRequest = fetchImpl.mock.calls[1]?.[1];
		const firstHeaders = firstRequest?.headers as Record<string, string>;

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(sleepImpl).toHaveBeenCalledWith(250);
		expect(Buffer.from(firstRequest?.body as Uint8Array)).toEqual(PNG);
		expect(Buffer.from(retryRequest?.body as Uint8Array)).toEqual(PNG);
		expect(result).toMatchObject({ ok: true, code: "result_images_uploaded" });
		expect(result.data.markdown).toContain("img_retry");
		expect(firstHeaders["content-type"]).toBe("application/octet-stream");
	});

	it("does not retry permanent HTTP failures", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "rejected.png"), PNG);
		const fetchImpl = vi.fn(
			async () => new Response(null, { status: 401 }),
		) as unknown as typeof fetch;

		const result = (await tool(root, fetchImpl).execute({
			images: [{ path: "rejected.png", alt: "Rejected" }],
		})) as { ok: boolean; data: { images: Array<{ code: string }> } };

		expect(fetchImpl).toHaveBeenCalledOnce();
		expect(result.data.images[0]?.code).toBe("upload_http_401");
	});

	it("applies an abort timeout to every request", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "stalled.png"), PNG);
		const fetchImpl = vi.fn(
			async (_url: string | URL | Request, init?: RequestInit): Promise<Response> =>
				await new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(init.signal?.reason), {
						once: true,
					});
				}),
		) as unknown as typeof fetch;

		const result = (await tool(root, fetchImpl, { requestTimeoutMs: 1 }).execute({
			images: [{ path: "stalled.png", alt: "Stalled" }],
		})) as { data: { images: Array<{ code: string }> } };

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(fetchImpl.mock.calls.every((call) => call[1]?.signal instanceof AbortSignal)).toBe(true);
		expect(result.data.images[0]?.code).toBe("upload_timeout");
	});

	it("returns failure after the retry is exhausted", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "failed.png"), PNG);
		const fetchImpl = vi.fn(async () => {
			throw new Error("network unavailable");
		}) as unknown as typeof fetch;

		const result = (await tool(root, fetchImpl).execute({
			images: [{ path: "failed.png", alt: "Failure" }],
		})) as { ok: boolean; code: string; data: { images: Array<{ code: string }> } };

		expect(fetchImpl).toHaveBeenCalledTimes(2);
		expect(result).toMatchObject({ ok: false, code: "result_images_upload_failed" });
		expect(result.data.images[0]?.code).toBe("upload_failed");
	});

	it("retains valid uploads when other entries fail local validation", async () => {
		const root = workspace();
		writeFileSync(path.join(root, "ok.png"), PNG);
		mkdirSync(path.join(root, "directory"));
		const outside = path.join(workspace(), "outside.png");
		writeFileSync(outside, PNG);
		symlinkSync(outside, path.join(root, "escape.png"));
		const fetchImpl = vi.fn(async () => success("img_ok")) as unknown as typeof fetch;
		const result = (await tool(root, fetchImpl).execute({
			images: [
				{ path: "missing.png", alt: "Missing" },
				{ path: "ok.png", alt: "Okay" },
				{ path: "directory", alt: "Dir" },
				{ path: "escape.png", alt: "Escape" },
			],
		})) as {
			ok: boolean;
			code: string;
			data: { images: Array<{ status: string; code?: string }>; markdown: string };
		};
		expect(result).toMatchObject({ ok: true, code: "result_images_partially_uploaded" });
		expect(result.data.images.map((entry) => entry.status)).toEqual([
			"failed",
			"uploaded",
			"failed",
			"failed",
		]);
		expect(result.data.images[3]?.code).toBe("path_outside_workspace");
		expect(result.data.markdown).toContain("![Okay]");
	});
});
