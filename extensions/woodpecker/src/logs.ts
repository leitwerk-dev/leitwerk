/** Keep a bounded tail without splitting a UTF-8 character. */
export function boundedLogTail(lines: string[], tailLines: number, maxBytes: number): string {
	const encoded = Buffer.from(lines.slice(-Math.min(Math.max(tailLines, 1), 2_000)).join("\n"));
	const cap = Math.min(Math.max(maxBytes, 1), 1_048_576);
	let start = Math.max(0, encoded.length - cap);
	while (start < encoded.length && (encoded[start] & 0xc0) === 0x80) start++;
	return encoded.subarray(start).toString("utf8");
}
