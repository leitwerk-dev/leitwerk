export interface RequestGuard {
	next(): number;
	isStale(gen: number): boolean;
	invalidate(): void;
}

export function createRequestGuard(): RequestGuard {
	let gen = 0;
	return {
		next() {
			return ++gen;
		},
		isStale(requestGen: number) {
			return requestGen !== gen;
		},
		invalidate() {
			gen++;
		},
	};
}
