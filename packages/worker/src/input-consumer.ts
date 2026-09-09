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

type InputDeliverySession = Pick<PiTreeHandle, "prompt" | "steer">;

export function classifyDeliveryMode(
	input: InputItem,
	sessionHasActiveTurn: boolean,
): InputDeliveryMode {
	return input.kind === "system_event" || sessionHasActiveTurn ? "steer" : "prompt";
}

export async function deliverInput(
	session: InputDeliverySession,
	input: InputItem,
	mode: InputDeliveryMode,
): Promise<DeliveredInput> {
	await session[mode](input.bodyMarkdown);
	return {
		inputId: input.inputId,
		sequence: input.sequence,
		deliveryMode: mode,
	};
}

export async function deliverBatch(
	session: InputDeliverySession,
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
