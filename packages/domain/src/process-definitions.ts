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

/** Whether a flow node sits on the shortest successful path or a side branch. @internal */
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

/** A statically declared LLM tool, without executable code or runtime credentials. @internal */
export interface ProcessFlowTool {
	/** @internal */
	name: string;
	/** @internal */
	category: "workspace" | "integration" | "question" | "outcome";
	/** Declared description when available; integration registrations are resolved separately. @internal */
	description: string | null;
}

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
	/** One logical turn applied to frozen items, followed by internal collection. @internal */
	repetition?: "sequential";
	/** Static declarations only; absent on non-LLM turns and older projections. @internal */
	tools?: ProcessFlowTool[];
	/** Additional integration tool names are resolved from process data at turn start. @internal */
	hasDynamicTools?: boolean;
	/** Named product declarations, not execution-time values. @internal */
	inputProducts?: string[];
	/** Named products this turn can publish. @internal */
	outputProducts?: string[];
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
	/** Declared branch condition; inspecting the graph never evaluates its chooser. @internal */
	condition?: {
		/** @internal */ label: string;
		/** @internal */ description?: string;
	};
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
 * Complete definition projection for operator-facing flow diagrams.
 * The `spine` is the shortest path from the primary entry to completion.
 * Operator decisions remain explicit; collection stays inside a mapped turn.
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
