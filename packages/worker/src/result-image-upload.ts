import { constants } from "node:fs";
import { open, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PiCustomTool } from "@leitwerk-dev/process-sdk";
import {
	buildWorkerResultImageUploadPath,
	parseWorkerResultImageUploadResponse,
	type ResultImageMimeType,
	WORKER_RESULT_IMAGE_WORKER_ID_HEADER,
} from "@leitwerk-dev/worker-protocol";
import { resolveWorkerHttpUrl } from "./worker-http.js";

type ImageEntry = { path: string; alt: string };
type FailedImage = ImageEntry & { status: "failed"; code: string; message: string };
type UploadedImage = ImageEntry & {
	status: "uploaded";
	imageId: string;
	url: string;
	markdown: string;
	mimeType: ResultImageMimeType;
	byteSize: number;
};
type ImageResult = FailedImage | UploadedImage;

const DEFAULT_UPLOAD_TIMEOUT_MS = 30_000;
const MAX_UPLOAD_ATTEMPTS = 2;
const RETRY_DELAY_MS = 250;

function failure(entry: ImageEntry, code: string, message: string): FailedImage {
	return { ...entry, status: "failed", code, message };
}

function isWithinRoot(rootReal: string, fileReal: string): boolean {
	const relative = path.relative(rootReal, fileReal);
	return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function isRetryableResponse(response: Response): boolean {
	return response.status >= 500;
}

async function sleep(ms: number): Promise<void> {
	if (ms <= 0) return;
	await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function readBoundedWorkspaceFile(
	entry: ImageEntry,
	workspaceRoot: string,
	maxSizeBytes: number,
): Promise<Buffer | FailedImage> {
	const rootReal = await realpath(workspaceRoot);
	const candidatePath = path.resolve(workspaceRoot, entry.path);
	const fileReal = await realpath(candidatePath);
	if (!isWithinRoot(rootReal, fileReal)) {
		return failure(
			entry,
			"path_outside_workspace",
			"Image path resolves outside the process workspace",
		);
	}
	const handle = await open(fileReal, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const before = await handle.stat();
		if (!before.isFile()) return failure(entry, "not_a_file", "Image path is not a regular file");
		if (before.size > maxSizeBytes) {
			return failure(entry, "image_too_large", `Image exceeds the ${maxSizeBytes}-byte limit`);
		}

		// Re-resolve the caller-visible path after opening and compare inode identity.
		// This rejects a final component or parent directory swapped during validation.
		const currentReal = await realpath(candidatePath);
		const current = await stat(currentReal);
		if (
			!isWithinRoot(rootReal, currentReal) ||
			current.dev !== before.dev ||
			current.ino !== before.ino
		) {
			return failure(entry, "image_changed", "Image path changed during validation");
		}

		const target = Buffer.alloc(before.size + 1);
		let offset = 0;
		while (offset < target.length) {
			const { bytesRead } = await handle.read(target, offset, target.length - offset, offset);
			if (bytesRead === 0) break;
			offset += bytesRead;
		}
		const after = await handle.stat();
		if (
			offset > maxSizeBytes ||
			after.size !== offset ||
			after.dev !== before.dev ||
			after.ino !== before.ino
		) {
			return failure(entry, "image_changed", "Image changed size during validation");
		}
		return target.subarray(0, offset);
	} finally {
		await handle.close();
	}
}

async function prepareImage(
	entry: ImageEntry,
	workspaceRoot: string,
	maxSizeBytes: number,
): Promise<Buffer | FailedImage> {
	if (!entry.path.trim() || !entry.alt.trim())
		return failure(entry, "invalid_image_entry", "Image path and alt text must be non-empty");
	try {
		return await readBoundedWorkspaceFile(entry, workspaceRoot, maxSizeBytes);
	} catch (error) {
		const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
		return failure(
			entry,
			missing ? "image_not_found" : "image_unreadable",
			missing ? "Image file does not exist" : "Image file could not be read safely",
		);
	}
}

export function createUploadResultImagesTool(input: {
	workspaceRoot: string;
	instanceId: string;
	turnRecordId: string;
	workerId: string;
	serverUrl: string;
	token: string;
	maxSizeBytes: number;
	fetchImpl?: typeof fetch;
	requestTimeoutMs?: number;
	sleepImpl?: (ms: number) => Promise<void>;
}): PiCustomTool {
	return {
		name: "upload_result_images",
		description:
			"Upload all intended repository-generated screenshots or visual goldens in one batch before the terminal outcome, then embed the Markdown snippets returned for successful entries. A partial upload failure must not block an otherwise valid result.",
		parameters: {
			images: {
				type: "array",
				minItems: 1,
				items: {
					type: "object",
					properties: { path: { type: "string" }, alt: { type: "string" } },
					required: ["path", "alt"],
				},
			},
		},
		executionMode: "sequential",
		async execute(args) {
			const raw = Array.isArray(args.images) ? args.images : [];
			if (raw.length === 0)
				return {
					ok: false,
					code: "result_images_upload_failed",
					message: "Provide at least one image",
					data: { images: [], markdown: "" },
				};
			const entries = raw.map((value): ImageEntry => {
				const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
				return {
					path: typeof record.path === "string" ? record.path : "",
					alt: typeof record.alt === "string" ? record.alt : "",
				};
			});
			const url = resolveWorkerHttpUrl(
				input.serverUrl,
				buildWorkerResultImageUploadPath(input.instanceId, input.turnRecordId),
			);
			const results: ImageResult[] = await Promise.all(
				entries.map(async (entry) => {
					const prepared = await prepareImage(entry, input.workspaceRoot, input.maxSizeBytes);
					if (!Buffer.isBuffer(prepared)) return prepared;
					let finalFailure = failure(entry, "upload_failed", "Image upload failed");
					for (let attempt = 0; attempt < MAX_UPLOAD_ATTEMPTS; attempt += 1) {
						let response: Response | null = null;
						const signal = AbortSignal.timeout(input.requestTimeoutMs ?? DEFAULT_UPLOAD_TIMEOUT_MS);
						try {
							response = await (input.fetchImpl ?? fetch)(url, {
								method: "POST",
								headers: {
									authorization: `Bearer ${input.token}`,
									[WORKER_RESULT_IMAGE_WORKER_ID_HEADER]: input.workerId,
									"content-type": "application/octet-stream",
								},
								body: new Uint8Array(prepared),
								signal,
							});
						} catch {
							finalFailure = failure(
								entry,
								signal.aborted ? "upload_timeout" : "upload_failed",
								signal.aborted ? "Image upload timed out" : "Image upload failed",
							);
						}
						if (response) {
							if (response.ok) {
								try {
									const body = parseWorkerResultImageUploadResponse(await response.json());
									if (!body)
										return failure(
											entry,
											"upload_invalid_response",
											"Image upload response was invalid",
										);
									return {
										...entry,
										status: "uploaded" as const,
										...body,
										markdown: `![${entry.alt.replace(/[\\\]]/g, "\\$&")}](${body.url})`,
									};
								} catch {
									return failure(
										entry,
										"upload_invalid_response",
										"Image upload response was invalid",
									);
								}
							}
							finalFailure = failure(
								entry,
								`upload_http_${response.status}`,
								`Image upload was rejected with HTTP ${response.status}`,
							);
							if (!isRetryableResponse(response)) return finalFailure;
						}
						if (attempt + 1 < MAX_UPLOAD_ATTEMPTS) {
							await (input.sleepImpl ?? sleep)(RETRY_DELAY_MS);
						}
					}
					return finalFailure;
				}),
			);
			const uploaded = results.filter(
				(result): result is UploadedImage => result.status === "uploaded",
			);
			const all = uploaded.length === results.length;
			const partial = uploaded.length > 0 && !all;
			return {
				ok: uploaded.length > 0,
				code: all
					? "result_images_uploaded"
					: partial
						? "result_images_partially_uploaded"
						: "result_images_upload_failed",
				message: all
					? "Uploaded all result images"
					: partial
						? `Uploaded ${uploaded.length} of ${results.length} result images`
						: "No result images were uploaded",
				data: { images: results, markdown: uploaded.map(({ markdown }) => markdown).join("\n\n") },
			};
		},
	};
}
