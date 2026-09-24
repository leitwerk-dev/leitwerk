/**
 * Only adjacent, explicitly linked retries of failed attempts form a group. Mapped
 * attempts also need the same item key.
 */
export function groupRetryChains<T>(
	items: readonly T[],
	record: (item: T) => {
		id: string;
		turnId: string;
		parentTurnRecordId?: string | null;
		failed: boolean;
		itemKey?: string;
	} | null,
): T[][] {
	const groups: T[][] = [];
	for (const item of items) {
		const current = record(item);
		const group = groups.at(-1);
		const previous = group?.at(-1);
		const parent = previous === undefined ? null : record(previous);
		if (
			current &&
			parent?.failed &&
			current.parentTurnRecordId === parent.id &&
			current.turnId === parent.turnId &&
			current.itemKey === parent.itemKey
		)
			group?.push(item);
		else groups.push([item]);
	}
	return groups;
}
