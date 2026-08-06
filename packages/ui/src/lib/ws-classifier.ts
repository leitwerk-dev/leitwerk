import {
	type PrimaryPathWsFrame,
	WS_PRIMARY_PATH_TYPES,
	type WsFrame,
} from "@leitwerk-dev/protocol";

export type WsAction =
	| { kind: "reload_list" }
	| { kind: "refresh_active_browse" }
	| { kind: "reload_detail"; instanceId: string }
	| { kind: "remove_deleted_detail"; instanceId: string }
	| { kind: "apply_primary_path_frame"; instanceId: string; frame: PrimaryPathWsFrame }
	| { kind: "ignored" };

const DETAIL_RELOAD_EVENTS = new Set([
	"plan.updated",
	"review.updated",
	"project.updated",
	"process.event",
	"process.input.queued",
	"process.input.acknowledged",
]);

const PRIMARY_PATH_FRAME_TYPES = new Set(Object.values(WS_PRIMARY_PATH_TYPES));

function isPrimaryPathFrame(frame: WsFrame): frame is PrimaryPathWsFrame {
	return PRIMARY_PATH_FRAME_TYPES.has(frame.type as PrimaryPathWsFrame["type"]);
}

function refreshBrowse(detailAction?: WsAction): WsAction[] {
	return [
		{ kind: "reload_list" },
		{ kind: "refresh_active_browse" },
		...(detailAction ? [detailAction] : []),
	];
}

export function classifyWsEvent(
	frame: WsFrame,
	currentDetailInstanceId: string | null,
): WsAction[] {
	const { type, instanceId } = frame;

	if (instanceId && instanceId === currentDetailInstanceId && isPrimaryPathFrame(frame)) {
		return [{ kind: "apply_primary_path_frame", instanceId, frame }];
	}

	if (type === "process.created") {
		return refreshBrowse();
	}

	if (type === "process.deleted") {
		const deletedInstanceId = instanceId ?? frame.payload.instanceId;
		return refreshBrowse(
			deletedInstanceId === currentDetailInstanceId
				? { kind: "remove_deleted_detail", instanceId: deletedInstanceId }
				: undefined,
		);
	}

	if (type === "future.updated") {
		return refreshBrowse(
			instanceId && instanceId === currentDetailInstanceId
				? { kind: "reload_detail", instanceId }
				: undefined,
		);
	}

	if (type === "process.updated" && instanceId) {
		return refreshBrowse(
			instanceId === currentDetailInstanceId ? { kind: "reload_detail", instanceId } : undefined,
		);
	}

	if (instanceId && instanceId === currentDetailInstanceId && DETAIL_RELOAD_EVENTS.has(type)) {
		return [{ kind: "reload_detail", instanceId }];
	}

	return [{ kind: "ignored" }];
}
