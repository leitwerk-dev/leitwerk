import type { ProcessActionSummary } from "../../lib/api.js";

export function describeActionPreview(
	action: ProcessActionSummary,
	options: { includeTurnKindPrefix?: boolean } = {},
): string | null {
	if (!action.preview) {
		return null;
	}
	if (action.preview.kind === "terminal") {
		return "Completes this process";
	}
	return options.includeTurnKindPrefix
		? `${action.preview.turnKind === "llm" ? "Next turn" : "Next step"} · ${action.preview.description}`
		: action.preview.description;
}
