import type { InputKind, InputSource } from "@leitwerk-dev/domain";

export interface PendingInput {
	id: string;
	instanceId: string;
	source: InputSource;
	kind: InputKind;
	bodyMarkdown: string;
	receivedAt: string;
}

export interface SequencedInput extends PendingInput {
	sequence: number;
}

export interface InputSequencerState {
	nextSequence: number;
}
