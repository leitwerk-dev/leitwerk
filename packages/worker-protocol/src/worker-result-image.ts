import * as v from "valibot";

/** @internal */
export const WORKER_RESULT_IMAGE_WORKER_ID_HEADER = "x-leitwerk-worker-id";
/** @internal */
export const RESULT_IMAGE_MIME_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
/** @internal */
export const RESULT_IMAGE_MAX_SIZE_BYTES = 10 * 1024 * 1024;
/** @internal */
export const RESULT_IMAGE_STORAGE_SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** @internal */
export const RESULT_IMAGE_ID_PATTERN = /^img_[A-Za-z0-9]+\.(png|jpg|webp)$/;
/** @internal */
export type ResultImageMimeType = (typeof RESULT_IMAGE_MIME_TYPES)[number];

/** @internal */
export function isResultImageStorageSegment(value: string): boolean {
	return RESULT_IMAGE_STORAGE_SEGMENT_PATTERN.test(value);
}

/** @internal */
export function parseResultImageId(value: string): {
	/** @internal */
	extension: "png" | "jpg" | "webp";
} | null {
	const extension = RESULT_IMAGE_ID_PATTERN.exec(value)?.[1];
	return extension === "png" || extension === "jpg" || extension === "webp" ? { extension } : null;
}

function assertResultImageStorageSegment(value: string): void {
	if (!isResultImageStorageSegment(value)) throw new Error("Invalid result image storage id");
}

/** @internal */
export const workerResultImageUploadResponseSchema = v.object({
	/** @internal */
	imageId: v.string(),
	/** @internal */
	url: v.string(),
	/** @internal */
	mimeType: v.picklist(RESULT_IMAGE_MIME_TYPES),
	/** @internal */
	byteSize: v.number(),
});

/** @internal */
export type WorkerResultImageUploadResponse = v.InferOutput<
	typeof workerResultImageUploadResponseSchema
>;

/** @internal */
export function buildWorkerResultImageUploadPath(instanceId: string, turnRecordId: string): string {
	assertResultImageStorageSegment(instanceId);
	assertResultImageStorageSegment(turnRecordId);
	return `/internal/workers/${instanceId}/turn-records/${turnRecordId}/result-images`;
}

/** @internal */
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

/** @internal */
export function parseManagedResultImagePath(value: string): {
	/** @internal */
	instanceId: string;
	/** @internal */
	turnRecordId: string;
	/** @internal */
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

/** @internal */
export function parseWorkerResultImageUploadResponse(
	value: unknown,
): WorkerResultImageUploadResponse | null {
	const parsed = v.safeParse(workerResultImageUploadResponseSchema, value);
	return parsed.success ? parsed.output : null;
}
