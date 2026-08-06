import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { RESULT_IMAGE_MAX_DIMENSION, validateResultImage } from "./result-image-validation.js";

function pixels(width = 2, height = 2) {
	return sharp({
		create: { width, height, channels: 4, background: { r: 20, g: 40, b: 60, alpha: 1 } },
	});
}

describe("validateResultImage", () => {
	it.each([
		["image/png", () => pixels().png().toBuffer()],
		["image/jpeg", () => pixels().jpeg().toBuffer()],
		["image/webp", () => pixels().webp().toBuffer()],
	] as const)("fully decodes a real %s image", async (mimeType, create) => {
		const bytes = await create();
		await expect(validateResultImage(bytes)).resolves.toMatchObject({
			ok: true,
			mimeType,
			width: 2,
			height: 2,
		});
	});

	it("rejects truncated data that only has a valid signature", async () => {
		const signatureOnlyPng = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
		await expect(validateResultImage(signatureOnlyPng)).resolves.toMatchObject({
			ok: false,
		});
	});

	it("rejects valid images with excessive dimensions", async () => {
		const bytes = await pixels(RESULT_IMAGE_MAX_DIMENSION + 1, 1)
			.png()
			.toBuffer();
		await expect(validateResultImage(bytes)).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("dimensions"),
		});
	});
});
