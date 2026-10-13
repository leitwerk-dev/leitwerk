import type { TurnId } from "./domain-model.js";

/** Breadth-first path in declaration order; null marks success. Returns [entry] without success. @internal */
export function shortestSuccessfulTurnPath(
	entry: TurnId,
	outgoing: (id: TurnId) => Iterable<TurnId | null>,
): TurnId[] {
	const parents = new Map<TurnId, TurnId | null>([[entry, null]]);
	for (const id of parents.keys()) {
		for (const next of outgoing(id)) {
			if (next === null) {
				const path: TurnId[] = [];
				let cursor: TurnId | null = id;
				while (cursor !== null) {
					path.push(cursor);
					cursor = parents.get(cursor) ?? null;
				}
				return path.reverse();
			}
			if (parents.has(next)) continue;
			parents.set(next, id);
		}
	}
	return [entry];
}
