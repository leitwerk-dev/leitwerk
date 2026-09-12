import { applyProcessPatchField, createWrites } from "../../process-engine/writes/writes.js";
import {
	mergeSemanticEntryRefPatchIntoStateJson as applySemanticEntryRefPatch,
	type ProcessSemanticEntryRefPatch,
} from "../../semantic-entry-ref-state.js";
import { accept, noWrites } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface UpdateSemanticRefsInput {
	instanceId: string;
	patch: ProcessSemanticEntryRefPatch;
}

export const UpdateSemanticRefs = defineOperation<
	"update_semantic_refs",
	UpdateSemanticRefsInput,
	void
>({
	kind: "update_semantic_refs",
	label: "Update semantic refs",
	decide(ctx, input) {
		const nextStateJson = applySemanticEntryRefPatch(ctx.process.stateJson, input.patch);
		if (nextStateJson === null) {
			return noWrites();
		}
		const writes = createWrites();
		applyProcessPatchField(writes, ctx.process, "stateJson", nextStateJson);
		return accept({ writes });
	},
});
