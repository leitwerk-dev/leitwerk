export function compareTimestampStrings(left: string, right: string): number {
	const leftMs = Date.parse(left);
	const rightMs = Date.parse(right);
	if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) {
		return leftMs - rightMs;
	}
	return left.localeCompare(right);
}

export function happenedOnOrAfterStart(entryTimestamp: string, startedAt: string | null): boolean {
	if (!startedAt) {
		return true;
	}
	return compareTimestampStrings(entryTimestamp, startedAt) >= 0;
}
