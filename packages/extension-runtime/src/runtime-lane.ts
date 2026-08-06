export type LeitwerkRuntimeLane = "source" | "dist";

export interface RuntimeLaneEnv {
	LEITWERK_RUNTIME_LANE?: string;
}

export const LEITWERK_RUNTIME_LANE_ENV = "LEITWERK_RUNTIME_LANE";

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

export function isSourceRuntimeLane(env: RuntimeLaneEnv = process.env): boolean {
	return resolveRuntimeLane(env) === "source";
}
