import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	createCanonicalPiResourceBundle,
	materializeCanonicalPiResourceBundle,
	persistPiResourceBundleForStart,
	verifyCanonicalPiResourceBundle,
} from "./pi-resource-bundle.js";

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
	const root = await mkdtemp(path.join(tmpdir(), "leitwerk-pi-resource-"));
	temporaryRoots.push(root);
	return root;
}

function rewriteChecksum(bytes: Buffer): void {
	bytes.fill(0x20, 148, 156);
	const sum = bytes.subarray(0, 512).reduce((total, byte) => total + byte, 0);
	Buffer.from(`${sum.toString(8).padStart(6, "0")}\0 `).copy(bytes, 148);
}

afterEach(async () => {
	await Promise.all(
		temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
	);
});

describe("Pi resource bundles", () => {
	it("creates identical canonical bytes regardless of input order", () => {
		const first = createCanonicalPiResourceBundle([
			{ path: "models.json", content: Buffer.from("models") },
			{ path: "extensions/provider.js", content: Buffer.from("extension") },
		]);
		const second = createCanonicalPiResourceBundle([
			{ path: "extensions/provider.js", content: Buffer.from("extension") },
			{ path: "models.json", content: Buffer.from("models") },
		]);
		expect(second.bytes).toEqual(first.bytes);
		expect(second.digest).toBe(first.digest);
	});

	it("rejects unsafe paths and non-regular tar entries", () => {
		expect(() =>
			createCanonicalPiResourceBundle([{ path: "../auth.json", content: Buffer.from("") }]),
		).toThrow("unsafe path");
		const bundle = createCanonicalPiResourceBundle([{ path: "safe", content: Buffer.from("x") }]);
		const absolute = Buffer.from(bundle.bytes);
		absolute.write("/etc/passwd", 0, "utf8");
		rewriteChecksum(absolute);
		expect(() => verifyCanonicalPiResourceBundle(absolute)).toThrow("unsafe path");

		const link = Buffer.from(bundle.bytes);
		link[156] = "2".charCodeAt(0);
		rewriteChecksum(link);
		expect(() => verifyCanonicalPiResourceBundle(link)).toThrow("unsupported entry type");
		const device = Buffer.from(bundle.bytes);
		device[156] = "3".charCodeAt(0);
		rewriteChecksum(device);
		expect(() => verifyCanonicalPiResourceBundle(device)).toThrow("unsupported entry type");
		const prefixed = Buffer.from(bundle.bytes);
		prefixed.write("hidden/", 345, "utf8");
		rewriteChecksum(prefixed);
		expect(() => verifyCanonicalPiResourceBundle(prefixed)).toThrow("path prefixes");
	});

	it("persists immutable bundles for starts and reuses them without delivered bytes", async () => {
		const root = await temporaryRoot();
		const bundlesDir = path.join(root, "pi-resource-bundles");
		const bundle = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		const first = await persistPiResourceBundleForStart({
			bundlesDir,
			startRecordId: "tsr_first",
			digest: bundle.digest,
			archiveBase64: Buffer.from(bundle.bytes).toString("base64"),
		});
		expect(first.reused).toBe(false);
		expect(first.bundle).toEqual(bundle.bytes);
		expect((await stat(path.join(bundlesDir, `${bundle.digest}.tar`))).mode & 0o777).toBe(0o600);

		const retry = await persistPiResourceBundleForStart({
			bundlesDir,
			startRecordId: "tsr_retry",
			digest: bundle.digest,
		});
		expect(retry).toEqual({ bundle: bundle.bytes, reused: true });
		expect(
			JSON.parse(await readFile(path.join(bundlesDir, "starts", "tsr_retry.json"), "utf8")),
		).toMatchObject({ startRecordId: "tsr_retry", digest: bundle.digest });
	});

	it("fails when a referenced process-volume bundle is missing", async () => {
		const root = await temporaryRoot();
		await expect(
			persistPiResourceBundleForStart({
				bundlesDir: path.join(root, "pi-resource-bundles"),
				startRecordId: "tsr_missing",
				digest: "0".repeat(64),
			}),
		).rejects.toThrow("unavailable on the process volume");
	});

	it("rejects a digest mismatch and atomically materializes verified bytes", async () => {
		const root = await temporaryRoot();
		const bundle = createCanonicalPiResourceBundle([
			{ path: "settings.json", content: Buffer.from("{}") },
		]);
		await expect(
			materializeCanonicalPiResourceBundle({
				bundle: bundle.bytes,
				digest: "0".repeat(64),
				targetDir: path.join(root, "agent"),
			}),
		).rejects.toThrow("content digest mismatch");
		await expect(stat(path.join(root, "agent"))).rejects.toMatchObject({ code: "ENOENT" });

		const targetDir = path.join(root, "agent");
		expect(
			await materializeCanonicalPiResourceBundle({
				bundle: bundle.bytes,
				digest: bundle.digest,
				targetDir,
			}),
		).toEqual({
			targetDir,
			reused: false,
		});
		expect(await readFile(path.join(targetDir, "settings.json"), "utf8")).toBe("{}");
		expect(
			await materializeCanonicalPiResourceBundle({
				bundle: bundle.bytes,
				digest: bundle.digest,
				targetDir,
			}),
		).toEqual({
			targetDir,
			reused: true,
		});
	});
});
