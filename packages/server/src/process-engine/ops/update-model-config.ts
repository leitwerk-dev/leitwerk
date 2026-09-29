import type { Actor } from "@leitwerk-dev/domain";
import type {
	ProcessModelConfigPatch,
	ProcessModelConfigResponseBody,
} from "@leitwerk-dev/protocol/http-contracts";
import { prepareProcessModelConfig } from "../../process-model-config.js";
import { accept, reject } from "../decision.js";
import { defineOperation } from "../operation.js";
import { appendProcessEvent, applyProcessPatchField, createWrites } from "../writes/writes.js";

/** @internal */
export const UpdateModelConfig = defineOperation<
	"update_model_config",
	{
		instanceId: string;
		patch: ProcessModelConfigPatch;
		actor: Actor;
	},
	ProcessModelConfigResponseBody
>({
	kind: "update_model_config",
	decide(ctx, input) {
		let prepared: ReturnType<typeof prepareProcessModelConfig>;
		try {
			prepared = prepareProcessModelConfig({
				process: ctx.process,
				patch: input.patch,
				policy: ctx.deps.processModelPolicy,
				availability: ctx.deps.getModelAvailabilitySnapshot(),
			});
		} catch (error) {
			return reject(
				"invalid_model_config",
				error instanceof Error ? error.message : "Invalid model configuration",
			);
		}
		const writes = createWrites();
		applyProcessPatchField(
			writes,
			ctx.process,
			"defaultModelProfileId",
			prepared.settings.defaultModelProfileId,
		);
		applyProcessPatchField(
			writes,
			ctx.process,
			"turnConfigsJson",
			prepared.settings.turnConfigsJson,
		);
		appendProcessEvent(writes, ctx.process, {
			eventType: "model_configuration_changed",
			level: "info",
			message: "Model defaults updated for future executions",
			data: {
				actor: input.actor,
				patch: input.patch,
				previous: {
					defaultModelProfileId: ctx.process.defaultModelProfileId,
					turnConfigsJson: ctx.process.turnConfigsJson,
				},
				settings: prepared.settings,
			},
		});
		return accept({ writes, data: { modelConfiguration: prepared.modelConfiguration } });
	},
});
