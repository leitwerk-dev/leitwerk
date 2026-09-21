import type { ProcessLifecycleStatus, ProcessTurnType, TurnId } from "./domain-model.js";

/** @public */
export type ProcessTurnTerminalLifecycleStatus = Extract<
	ProcessLifecycleStatus,
	"completed" | "aborted"
>;

/** @internal */
export interface ProcessTurnTransition {
	/** @internal */
	nextTurnId?: TurnId;
	/** @internal */
	lifecycleStatus?: ProcessTurnTerminalLifecycleStatus;
	/** @internal */
	outcome?: string;
	/** @internal */
	trigger?: string;
}

/** Wire DTO used by HTTP clients that need serialized process graph data. @internal */
export interface SerializedProcessGraph {
	/** @internal */
	id: string;
	/** @internal */
	entryTurnIds: TurnId[];
	/** @internal */
	reachableTurnIds: TurnId[];
	/** @internal */
	turnTransitions: Record<TurnId, ProcessTurnTransition[]>;
}

/** Whether a flow node sits on the declared happy path (`spine`) or hangs off it (`branch`). @internal */
export type ProcessFlowNodeRole = "spine" | "branch";

/**
 * Classification of a flow edge relative to the spine:
 * - `forward`: progresses along the spine toward completion
 * - `loopback`: returns to an earlier or equal spine position (revision/dismiss loops)
 * - `branch`: leaves the spine toward an offshoot node
 * - `terminal`: ends the process with a lifecycle status
 */
/** @internal */
export type ProcessFlowEdgeKind = "forward" | "loopback" | "branch" | "terminal";

/** @internal */
export interface ProcessFlowNode {
	/** @internal */
	turnId: TurnId;
	/** @internal */
	description: string;
	/** @internal */
	turnType: ProcessTurnType;
	/** @internal */
	role: ProcessFlowNodeRole;
	/** Position on the spine when `role === "spine"`, otherwise `null`. @internal */
	spineIndex: number | null;
	/** The spine node this branch hangs off, when derivable. `null` for spine nodes. @internal */
	anchorTurnId: TurnId | null;
	/** True when this turn is a launch entry point. @internal */
	isEntry: boolean;
}

/** @internal */
export interface ProcessFlowEdge {
	/** @internal */
	from: TurnId;
	/** Target turn for non-terminal edges. @internal */
	to: TurnId | null;
	/** Lifecycle status for `terminal` edges. @internal */
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus | null;
	/** @internal */
	kind: ProcessFlowEdgeKind;
	/** Optional human-facing edge label derived from outcome/trigger metadata. @internal */
	label: string | null;
}

/** @internal */
export interface ProcessFlowEndState {
	/** @internal */
	lifecycleStatus: ProcessTurnTerminalLifecycleStatus;
	/**
	 * True when the end state is not reached by an explicit graph transition.
	 * Abort is always reachable from any active turn, so it is synthesized.
	 */
	/** @internal */
	synthetic: boolean;
}

/**
 * Spine-first projection of a process graph for operator-facing flow diagrams.
 * The `spine` is the happy path; everything else hangs off it as branches and loops.
 */
/** @internal */
export interface ProcessFlowView {
	/** @internal */
	processId: string;
	/** @internal */
	entryTurnIds: TurnId[];
	/** @internal */
	spine: TurnId[];
	/** @internal */
	nodes: ProcessFlowNode[];
	/** @internal */
	edges: ProcessFlowEdge[];
	/** @internal */
	endStates: ProcessFlowEndState[];
}
