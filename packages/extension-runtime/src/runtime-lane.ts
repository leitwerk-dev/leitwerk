/** @internal */
export type LeitwerkRuntimeLane = "source" | "dist";

/** @internal */
export interface RuntimeLaneEnv {
	/** @internal */
	LEITWERK_RUNTIME_LANE?: string;
}

/** @internal */
export const LEITWERK_RUNTIME_LANE_ENV = "LEITWERK_RUNTIME_LANE";

/** @internal */
export function resolveRuntimeLane(env: RuntimeLaneEnv = process.env): LeitwerkRuntimeLane {
	const lane = env.LEITWERK_RUNTIME_LANE;
	if (lane === undefined || lane === "") {
		return "dist";
	}
	if (lane === "source" || lane === "dist") {
		return lane;
	}
	throw new Error(`${LEITWERK_RUNTIME_LANE_ENV} must be 'source' or 'dist', got '${lane}'`);
}

/** @internal */
export function isSourceRuntimeLane(env: RuntimeLaneEnv = process.env): boolean {
	return resolveRuntimeLane(env) === "source";
}
