import { trimString } from "@leitwerk-dev/domain";
import type { Codec, LauncherValidationError } from "@leitwerk-dev/process-sdk";

/** @internal */
export interface ProcessAnalysisParams {
	/** @internal */
	processRef: string;
	/** @internal */
	instruction: string;
	/** Hidden launch param: absolute directory where the server was started. @internal */
	analysisCwd: string;
}

/** @internal */
export const processAnalysisParamsCodec: Codec<ProcessAnalysisParams> = {
	parse(value) {
		const record = typeof value === "object" && value !== null ? value : {};
		return {
			processRef: trimString((record as { processRef?: unknown }).processRef),
			instruction: trimString((record as { instruction?: unknown }).instruction),
			analysisCwd: trimString((record as { analysisCwd?: unknown }).analysisCwd),
		};
	},
	serialize(value) {
		return value;
	},
};

/** Visible fields validated at launch time. analysisCwd is merged by the launcher. @internal */
export type VisibleProcessAnalysisParams = Omit<ProcessAnalysisParams, "analysisCwd">;

/** @internal */
export function validateProcessAnalysisLaunchInput(input: Record<string, unknown>):
	| {
			/** @internal */
			ok: true;
			/** @internal */
			value: VisibleProcessAnalysisParams;
	  }
	| {
			/** @internal */
			ok: false;
			/** @internal */
			errors: readonly LauncherValidationError[];
	  } {
	const processRef = trimString(input.processRef);
	const instruction = trimString(input.instruction);
	const errors: LauncherValidationError[] = [];
	if (!processRef)
		errors.push({ code: "required", fieldId: "processRef", message: "processRef is required" });
	if (!instruction)
		errors.push({ code: "required", fieldId: "instruction", message: "instruction is required" });
	return errors.length ? { ok: false, errors } : { ok: true, value: { processRef, instruction } };
}
