import { createHash } from "node:crypto";
import path from "node:path";

const BLOCK_SIZE = 512;

export interface PiResourceFile {
	path: string;
	content: Uint8Array;
}

export interface PiResourceBundle {
	digest: string;
	bytes: Uint8Array;
}

export interface ExtractedPiResourceFile {
	path: string;
	content: Uint8Array;
}

function fail(message: string): never {
	throw new Error(`Invalid Pi resource bundle: ${message}`);
}

export function validateResourceRelativePath(value: string): string {
	if (!value || path.posix.isAbsolute(value) || value.includes("\\")) {
		fail(`unsafe path '${value}'`);
	}
	const normalized = path.posix.normalize(value);
	if (normalized === "." || normalized === ".." || normalized.startsWith("../")) {
		fail(`unsafe path '${value}'`);
	}
	return normalized;
}

function writeString(buffer: Buffer, offset: number, length: number, value: string): void {
	const encoded = Buffer.from(value, "utf8");
	if (encoded.length > length) fail(`header value too long: ${value}`);
	encoded.copy(buffer, offset);
}

function writeOctal(buffer: Buffer, offset: number, length: number, value: number): void {
	const encoded = value.toString(8).padStart(length - 1, "0");
	if (encoded.length > length - 1) fail(`numeric header value too large: ${value}`);
	writeString(buffer, offset, length - 1, encoded);
	buffer[offset + length - 1] = 0;
}

function header(name: string, size: number): Buffer {
	if (Buffer.byteLength(name) > 100) fail(`path exceeds canonical ustar name limit: ${name}`);
	const result = Buffer.alloc(BLOCK_SIZE);
	writeString(result, 0, 100, name);
	writeOctal(result, 100, 8, 0o644);
	writeOctal(result, 108, 8, 0);
	writeOctal(result, 116, 8, 0);
	writeOctal(result, 124, 12, size);
	writeOctal(result, 136, 12, 0);
	result.fill(0x20, 148, 156);
	result[156] = "0".charCodeAt(0);
	writeString(result, 257, 6, "ustar");
	writeString(result, 263, 2, "00");
	const sum = result.reduce((total, byte) => total + byte, 0);
	writeString(result, 148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
	return result;
}

function padding(size: number): Buffer {
	const length = (BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE;
	return Buffer.alloc(length);
}

export function sha256Digest(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

/** Creates a deterministic, uncompressed ustar archive containing regular files only. */
export function createCanonicalPiResourceBundle(
	files: readonly PiResourceFile[],
): PiResourceBundle {
	const seen = new Set<string>();
	const normalized = files.map((file) => {
		const resourcePath = validateResourceRelativePath(file.path);
		if (seen.has(resourcePath)) fail(`duplicate path '${resourcePath}'`);
		seen.add(resourcePath);
		return { path: resourcePath, content: Buffer.from(file.content) };
	});
	normalized.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
	const chunks: Buffer[] = [];
	for (const file of normalized) {
		chunks.push(header(file.path, file.content.length), file.content, padding(file.content.length));
	}
	chunks.push(Buffer.alloc(BLOCK_SIZE * 2));
	const bytes = Buffer.concat(chunks);
	return { bytes, digest: sha256Digest(bytes) };
}

function readNullString(block: Uint8Array, start: number, length: number): string {
	const end = block.subarray(start, start + length).indexOf(0);
	return Buffer.from(block.subarray(start, end < 0 ? start + length : start + end)).toString(
		"utf8",
	);
}

function readOctal(block: Uint8Array, start: number, length: number): number {
	const raw = readNullString(block, start, length).trim();
	if (!/^[0-7]*$/.test(raw)) fail("non-octal numeric field");
	return raw ? Number.parseInt(raw, 8) : 0;
}

function verifyChecksum(block: Uint8Array): void {
	const expected = readOctal(block, 148, 8);
	let actual = 0;
	for (let index = 0; index < BLOCK_SIZE; index++) {
		actual += index >= 148 && index < 156 ? 32 : block[index];
	}
	if (actual !== expected) fail("header checksum mismatch");
}

function allZero(block: Uint8Array): boolean {
	return block.every((byte) => byte === 0);
}

/** Parses only the narrow regular-file ustar subset emitted by this module. */
export function verifyCanonicalPiResourceBundle(
	bytes: Uint8Array,
	expectedDigest?: string,
): ExtractedPiResourceFile[] {
	if (expectedDigest && sha256Digest(bytes) !== expectedDigest) fail("content digest mismatch");
	if (bytes.length < BLOCK_SIZE * 2 || bytes.length % BLOCK_SIZE !== 0) {
		fail("invalid archive length");
	}
	const files: ExtractedPiResourceFile[] = [];
	const paths = new Set<string>();
	let offset = 0;
	while (offset < bytes.length) {
		const block = bytes.subarray(offset, offset + BLOCK_SIZE);
		if (allZero(block)) {
			if (!allZero(bytes.subarray(offset + BLOCK_SIZE, offset + BLOCK_SIZE * 2))) {
				fail("missing end blocks");
			}
			if (offset + BLOCK_SIZE * 2 !== bytes.length) fail("data after end blocks");
			return files;
		}
		verifyChecksum(block);
		if (readNullString(block, 257, 6) !== "ustar") fail("unsupported tar format");
		const type = readNullString(block, 156, 1);
		if (type !== "" && type !== "0") fail(`unsupported entry type '${type}'`);
		if (readNullString(block, 157, 100) || readNullString(block, 345, 155)) {
			fail("links and ustar path prefixes are unsupported");
		}
		const name = validateResourceRelativePath(readNullString(block, 0, 100));
		if (paths.has(name)) fail(`duplicate path '${name}'`);
		paths.add(name);
		const size = readOctal(block, 124, 12);
		const contentStart = offset + BLOCK_SIZE;
		const contentEnd = contentStart + size;
		if (contentEnd > bytes.length) fail("truncated file content");
		files.push({ path: name, content: bytes.slice(contentStart, contentEnd) });
		offset = contentEnd + ((BLOCK_SIZE - (size % BLOCK_SIZE)) % BLOCK_SIZE);
	}
	fail("missing end blocks");
}
