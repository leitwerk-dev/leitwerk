import type { ProcessInputTarget } from "@leitwerk-dev/domain";
import type { PiTreeHandle } from "./pi-adapter.js";

export type InputDeliveryMode = "prompt" | "steer";

export interface DeliveredInput {
	inputId: string;
	sequence: number;
	deliveryMode: InputDeliveryMode;
}

export interface InputItem {
	inputId: string;
	sequence: number;
	source: string;
	kind: string;
	target: ProcessInputTarget | null;
	bodyMarkdown: string;
}

export type TargetedInputItem = InputItem & { target: NonNullable<InputItem["target"]> };

export function filterInputsAfterConsumedSequence(
	inputs: readonly InputItem[],
	lastSequenceConsumed: number,
): InputItem[] {
	return inputs.filter((input) => input.sequence > lastSequenceConsumed);
}

export function classifyDeliveryMode(
	input: InputItem,
	sessionHasActiveTurn: boolean,
): InputDeliveryMode {
	if (input.kind === "system_event") {
		return "steer";
	}
	if (sessionHasActiveTurn) {
		return "steer";
	}
	return "prompt";
}

export async function deliverInput(
	session: PiTreeHandle,
	input: InputItem,
	mode: InputDeliveryMode,
): Promise<DeliveredInput> {
	if (mode === "prompt") {
		await session.prompt(input.bodyMarkdown);
	} else {
		await session.steer(input.bodyMarkdown);
	}
	return {
		inputId: input.inputId,
		sequence: input.sequence,
		deliveryMode: mode,
	};
}

export async function deliverBatch(
	session: PiTreeHandle,
	inputs: InputItem[],
	hasActiveTurn: boolean,
): Promise<DeliveredInput[]> {
	const out: DeliveredInput[] = [];
	for (let i = 0; i < inputs.length; i++) {
		const mode = i === 0 ? classifyDeliveryMode(inputs[i], hasActiveTurn) : "steer";
		out.push(await deliverInput(session, inputs[i], mode));
	}
	return out;
}
