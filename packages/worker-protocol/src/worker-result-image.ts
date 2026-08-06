import * as v from "valibot";

export const WORKER_RESULT_IMAGE_WORKER_ID_HEADER = "x-leitwerk-worker-id";
export const RESULT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const RESULT_IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
export const RESULT_IMAGE_STORAGE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const RESULT_IMAGE_ID_PATTERN = /^img_[A-Za-z0-9]+\.(png|jpg|webp)$/;
export type ResultImageMimeType = (typeof RESULT_IMAGE_MIME_TYPES)[number];

export function isResultImageStorageSegment(value: string): boolean {
	return RESULT_IMAGE_STORAGE_SEGMENT_PATTERN.test(value);
}

export function parseResultImageId(value: string): { extension: "png" | "jpg" | "webp" } | null {
	const extension = RESULT_IMAGE_ID_PATTERN.exec(value)?.[1];
	return extension === "png" || extension === "jpg" || extension === "webp" ? { extension } : null;
}

function assertResultImageStorageSegment(value: string): void {
	if (!isResultImageStorageSegment(value)) throw new Error("Invalid result image storage id");
}

export const workerResultImageUploadResponseSchema = v.object({
	imageId: v.string(),
	url: v.string(),
	mimeType: v.picklist(RESULT_IMAGE_MIME_TYPES),
	byteSize: v.number(),
});

export type WorkerResultImageUploadResponse = v.InferOutput<
	typeof workerResultImageUploadResponseSchema
>;

export function buildWorkerResultImageUploadPath(instanceId: string, turnRecordId: string): string {
	assertResultImageStorageSegment(instanceId);
	assertResultImageStorageSegment(turnRecordId);
	return `/internal/workers/${instanceId}/turn-records/${turnRecordId}/result-images`;
}

export function buildManagedResultImagePath(
	instanceId: string,
	turnRecordId: string,
	imageId: string,
): string {
	assertResultImageStorageSegment(instanceId);
	assertResultImageStorageSegment(turnRecordId);
	if (!parseResultImageId(imageId)) throw new Error("Invalid result image id");
	return `/api/processes/${instanceId}/turn-records/${turnRecordId}/result-images/${imageId}`;
}

const MANAGED_RESULT_IMAGE_PATH =
	/^\/api\/processes\/([^/]+)\/turn-records\/([^/]+)\/result-images\/([^/]+)$/;

export function parseManagedResultImagePath(value: string): {
	instanceId: string;
	turnRecordId: string;
	imageId: string;
} | null {
	const match = MANAGED_RESULT_IMAGE_PATH.exec(value);
	const instanceId = match?.[1];
	const turnRecordId = match?.[2];
	const imageId = match?.[3];
	return instanceId &&
		turnRecordId &&
		imageId &&
		isResultImageStorageSegment(instanceId) &&
		isResultImageStorageSegment(turnRecordId) &&
		parseResultImageId(imageId)
		? { instanceId, turnRecordId, imageId }
		: null;
}

export function parseWorkerResultImageUploadResponse(
	value: unknown,
): WorkerResultImageUploadResponse | null {
	const parsed = v.safeParse(workerResultImageUploadResponseSchema, value);
	return parsed.success ? parsed.output : null;
}
