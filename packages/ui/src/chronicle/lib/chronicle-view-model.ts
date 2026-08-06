import type { ProcessTimelineTurnSummary } from "@leitwerk-dev/protocol";
import { formatTurnId } from "../../lib/format";
import { markdownToPlainText, truncateText } from "../../lib/markdown";

type TurnRecordView = ProcessTimelineTurnSummary;

export type ChronicleTurnShape = "circle" | "diamond" | "pill" | "square";
export type ChronicleTurnPresentation = TurnRecordView["presentation"];

export interface ChronicleTurnRailItem {
	turnRecordId: string;
	turnId: string;
	title: string;
	turnLabel: string;
	status: TurnRecordView["status"];
	createdAt: string;
	shape: ChronicleTurnShape;
	presentation: ChronicleTurnPresentation;
	hierarchy: "primary" | "secondary";
	kindLabel: string;
}

export interface ChronicleCompletedTurnSection {
	turnRecordId: string;
	turnId: string;
	title: string;
	turnLabel: string;
	createdAt: string;
	preview: string;
}

export interface ChronicleLiveTailModel {
	turnRecordId: string;
	turnId: string;
	title: string;
	copy: string;
}

export function formatChronicleTurnLabel(value: string): string {
	return formatTurnId(value);
}

export function getChronicleTurnPresentation(
	turnRecord: Pick<TurnRecordView, "presentation">,
): ChronicleTurnPresentation {
	return turnRecord.presentation;
}

export function getChronicleTurnKindLabel(
	turnRecord: Pick<TurnRecordView, "presentation">,
): string {
	switch (getChronicleTurnPresentation(turnRecord)) {
		case "operator_decision":
			return "Operator decision";
		case "external_trigger":
			return "External trigger";
		case "automatic_turn":
			return "Automation";
		default:
			return "LLM turn";
	}
}

export function getChronicleTurnHierarchy(
	turnRecord: Pick<TurnRecordView, "presentation">,
): "primary" | "secondary" {
	const presentation = getChronicleTurnPresentation(turnRecord);
	return presentation === "llm_turn" || presentation === "automatic_turn" ? "primary" : "secondary";
}

export function getChronicleTurnShape(
	turnRecord: Pick<TurnRecordView, "turnId" | "outcome" | "turnType">,
): ChronicleTurnShape {
	const turnKey = turnRecord.turnId;
	if (turnRecord.outcome === "failed") {
		return "square";
	}
	if (
		turnRecord.turnType === "human" ||
		turnRecord.turnType === "external" ||
		turnKey === "plan_review" ||
		turnKey === "implementation_review" ||
		turnKey === "mr_polish_review" ||
		turnKey === "poem_review" ||
		turnKey === "poem_review_feedback"
	) {
		return "pill";
	}
	if (turnKey === "run_llm_review" || turnKey === "review_poem_draft") {
		return "diamond";
	}
	return "circle";
}

export function getChronicleTurnPreview(
	turnRecord: Pick<TurnRecordView, "displayTurn" | "output" | "summary" | "turnResultMarkdown">,
	maxLength = 220,
): string {
	const source =
		turnRecord.turnResultMarkdown ||
		turnRecord.output ||
		turnRecord.summary ||
		formatChronicleTurnLabel(turnRecord.displayTurn);
	const plain = turnRecord.turnResultMarkdown ? markdownToPlainText(source) : source.trim();
	return truncateText(plain, maxLength);
}

export function buildChronicleTurnRailItem(turnRecord: TurnRecordView): ChronicleTurnRailItem {
	return {
		turnRecordId: turnRecord.id,
		turnId: turnRecord.turnId,
		title: formatChronicleTurnLabel(turnRecord.displayTurn),
		turnLabel: turnRecord.turnId,
		status: turnRecord.status,
		createdAt: turnRecord.createdAt,
		shape: getChronicleTurnShape(turnRecord),
		presentation: getChronicleTurnPresentation(turnRecord),
		hierarchy: getChronicleTurnHierarchy(turnRecord),
		kindLabel: getChronicleTurnKindLabel(turnRecord),
	};
}
