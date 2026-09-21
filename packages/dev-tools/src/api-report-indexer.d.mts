/** @internal */
export function createSnapshot(
	root: string,
	output: string,
	options?: {
		extract?: boolean;
		packageDirs?: string[];
		sourceRoots?: string[];
		sourceOriginRoots?: { root: string; origin: "workspace" | "composition" }[];
	},
): Promise<{
	contentFingerprint: string;
	version: number;
	repository: { id: string; name: string; revision: string; dirty: boolean };
	nodes: unknown[];
	occurrences: unknown[];
}>;
