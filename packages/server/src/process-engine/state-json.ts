import { parseSemanticEntryRefsFromStateJsonLenient } from "@leitwerk-dev/domain";

export function readCurrentPrimaryPathLeafEntryId(
	stateJson: string | null | undefined,
): string | null {
	return (
		parseSemanticEntryRefsFromStateJsonLenient(stateJson).currentPrimaryPathLeaf?.entryId ?? null
	);
}
