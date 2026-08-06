import type { ResultImageMimeType } from "@leitwerk-dev/worker-protocol";
import sharp from "sharp";

export const RESULT_IMAGE_MAX_DIMENSION = 10_000;
export const RESULT_IMAGE_MAX_PIXELS = 25_000_000;

const MIME_BY_FORMAT: Record<string, ResultImageMimeType | undefined> = {
	png: "image/png",
	jpeg: "image/jpeg",
	webp: "image/webp",
};

export type ResultImageValidationResult =
	| { ok: true; mimeType: ResultImageMimeType; width: number; height: number }
	| { ok: false; error: string };

/** Fully decodes one bounded, non-animated image before it crosses the durable storage boundary. */
export async function validateResultImage(bytes: Buffer): Promise<ResultImageValidationResult> {
	try {
		const image = sharp(bytes, {
			animated: true,
			failOn: "error",
			limitInputPixels: RESULT_IMAGE_MAX_PIXELS,
			sequentialRead: true,
		});
		const metadata = await image.metadata();
		const mimeType = metadata.format ? MIME_BY_FORMAT[metadata.format] : undefined;
		const width = metadata.width ?? 0;
		const height = metadata.height ?? 0;
		if (!mimeType) return { ok: false, error: "Image format is not supported" };
		if (width <= 0 || height <= 0) {
			return { ok: false, error: "Image dimensions are invalid" };
		}
		if (width > RESULT_IMAGE_MAX_DIMENSION || height > RESULT_IMAGE_MAX_DIMENSION) {
			return {
				ok: false,
				error: `Image dimensions exceed ${RESULT_IMAGE_MAX_DIMENSION} pixels`,
			};
		}
		if (width * height > RESULT_IMAGE_MAX_PIXELS) {
			return { ok: false, error: `Image exceeds ${RESULT_IMAGE_MAX_PIXELS} decoded pixels` };
		}
		if ((metadata.pages ?? 1) !== 1) {
			return { ok: false, error: "Animated or multi-page images are not supported" };
		}
		// metadata() reads headers; stats() forces libvips to decode the complete image.
		await image.stats();
		return { ok: true, mimeType, width, height };
	} catch {
		return { ok: false, error: "Image is malformed or exceeds decoded image limits" };
	}
}
