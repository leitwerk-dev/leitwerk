import {
	applyPiEventToLiveTurnProjection,
	createMutableLiveTurnProjection,
	snapshotTurnTrace,
	type TurnReasoningDetailResponseBody,
	type TurnTraceSnapshot,
	type WsFrame,
} from "@leitwerk-dev/protocol";

const PI_EVENT_TYPES: Record<string, string> = {
	"pi.stream.delta": "pi.stream.delta",
	"pi.stream.started": "pi.turn.start",
	"pi.stream.completed": "pi.turn.end",
	"pi.tool.started": "pi.tool.call",
	"pi.tool.completed": "pi.tool.result",
	"pi.usage": "pi.usage",
	"pi.error": "pi.error",
	"pi.retry.start": "pi.retry.start",
	"pi.retry.end": "pi.retry.end",
	"pi.compaction.start": "pi.compaction.start",
	"pi.compaction.end": "pi.compaction.end",
};

/** Owns expanded history only. HTTP recovery replaces its base, then replays later frames once. */
export class ReasoningHistory {
	private projection = createMutableLiveTurnProjection();
	private boundary = 0;
	private buffered = new Map<number, WsFrame>();
	private pending = false;
	private committed = false;
	private piInput: TurnTraceSnapshot["piInput"] = null;
	constructor(
		readonly instanceId: string,
		readonly turnRecordId: string,
	) {}

	beginRequest() {
		this.pending = true;
	}
	failedRequest() {
		this.pending = false;
		this.buffered.clear();
	}
	accept(response: TurnReasoningDetailResponseBody): TurnTraceSnapshot {
		if (response.instanceId !== this.instanceId || response.turnRecordId !== this.turnRecordId)
			throw new Error("Reasoning response belongs to another turn");
		this.projection = createMutableLiveTurnProjection();
		this.projection.assistant = { ...response.reasoning.assistant };
		this.projection.traceItems = response.reasoning.traceItems.map((item) => ({ ...item }));
		this.projection.toolCalls = response.reasoning.toolCalls.map((tool) => ({
			...tool,
			result: tool.resultText,
		}));
		this.projection.toolCallsById = new Map(
			this.projection.toolCalls.map((tool) => [tool.toolCallId, tool]),
		);
		this.projection.usage = response.reasoning.usage;
		this.piInput = response.reasoning.piInput;
		this.boundary = response.throughEventSequence;
		this.committed = response.state === "committed";
		this.pending = false;
		for (const frame of [...this.buffered.values()].sort(
			(a, b) => (a.eventSequence ?? 0) - (b.eventSequence ?? 0),
		))
			this.apply(frame);
		this.buffered.clear();
		return this.snapshot();
	}
	push(frame: WsFrame): TurnTraceSnapshot | null {
		if (
			frame.instanceId !== this.instanceId ||
			!("turnRecordId" in frame.payload) ||
			frame.payload.turnRecordId !== this.turnRecordId ||
			frame.eventSequence === undefined ||
			!PI_EVENT_TYPES[frame.type]
		)
			return null;
		if (this.pending) this.buffered.set(frame.eventSequence, frame);
		return this.apply(frame) ? this.snapshot() : null;
	}
	private apply(frame: WsFrame): boolean {
		if (this.committed || frame.eventSequence === undefined || frame.eventSequence <= this.boundary)
			return false;
		applyPiEventToLiveTurnProjection(this.projection, {
			eventType: PI_EVENT_TYPES[frame.type],
			data: frame.payload as Record<string, unknown>,
			fallbackTimestamp: frame.sentAt,
		});
		this.boundary = frame.eventSequence;
		return true;
	}
	snapshot(): TurnTraceSnapshot {
		return snapshotTurnTrace(this.projection, this.piInput);
	}
}
