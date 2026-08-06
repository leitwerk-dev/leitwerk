import { applyProcessPatchField, createWrites } from "../../process-engine/writes/writes.js";
import {
	mergeProductRefPatchIntoStateJson,
	type ProcessProductRefPatch,
} from "../../product-ref-state.js";
import { accept, noWrites } from "../decision.js";
import { defineOperation } from "../operation.js";

export interface UpdateProductRefsInput {
	instanceId: string;
	patch: ProcessProductRefPatch;
}

export const UpdateProductRefs = defineOperation<
	"update_product_refs",
	UpdateProductRefsInput,
	void
>({
	kind: "update_product_refs",
	label: "Update product refs",
	decide(ctx, input) {
		const nextStateJson = mergeProductRefPatchIntoStateJson(ctx.process.stateJson, input.patch);
		if (nextStateJson === null) {
			return noWrites();
		}
		const writes = createWrites();
		applyProcessPatchField(writes, ctx.process, "stateJson", nextStateJson);
		return accept({ writes });
	},
});
