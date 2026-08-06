import type { ProcessLifecycleStatus, ProcessTurnType, TurnId } from "./domain-model.js";

export type ProcessTurnTerminalLifecycleStatus = Extract<
	ProcessLifecycleStatus,
	"completed" | "aborted"
>;

export interface ProcessTurnTransition {
	nextTurnId?: TurnId;
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	outcome?: string;
	trigger?: string;
}

/** Wire DTO used by HTTP clients that need serialized process graph data. */
export interface SerializedProcessGraph {
	id: string;
	entryTurnIds: TurnId[];
	reachableTurnIds: TurnId[];
	turnTransitions: Record<TurnId, ProcessTurnTransition[]>;
}

/** Whether a flow node sits on the declared happy path (`spine`) or hangs off it (`branch`). */
export type ProcessFlowNodeRole = "spine" | "branch";

/**
 * Classification of a flow edge relative to the spine:
 * - `forward`: progresses along the spine toward completion
 * - `loopback`: returns to an earlier or equal spine position (revision/dismiss loops)
 * - `branch`: leaves the spine toward an offshoot node
 * - `terminal`: ends the process with a lifecycle status
 */
export type ProcessFlowEdgeKind = "forward" | "loopback" | "branch" | "terminal";

export interface ProcessFlowNode {
	turnId: TurnId;
	description: string;
	turnType: ProcessTurnType;
	role: ProcessFlowNodeRole;
	/** Position on the spine when `role === "spine"`, otherwise `null`. */
	spineIndex: number | null;
	/** The spine node this branch hangs off, when derivable. `null` for spine nodes. */
	anchorTurnId: TurnId | null;
	/** True when this turn is a launch entry point. */
	isEntry: boolean;
}

export interface ProcessFlowEdge {
	from: TurnId;
	/** Target turn for non-terminal edges. */
	to: TurnId | null;
	/** Lifecycle status for `terminal` edges. */
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
	kind: ProcessFlowEdgeKind;
	/** Optional human-facing edge label derived from outcome/trigger metadata. */
	label: string | null;
}

export interface ProcessFlowEndState {
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus;
	/**
	 * True when the end state is not reached by an explicit graph transition.
	 * Abort is always reachable from any active turn, so it is synthesized.
	 */
	synthetic: boolean;
}

/**
 * Spine-first projection of a process graph for operator-facing flow diagrams.
 * The `spine` is the happy path; everything else hangs off it as branches and loops.
 */
export interface ProcessFlowView {
	processId: string;
	entryTurnIds: TurnId[];
	spine: TurnId[];
	nodes: ProcessFlowNode[];
	edges: ProcessFlowEdge[];
	endStates: ProcessFlowEndState[];
}
