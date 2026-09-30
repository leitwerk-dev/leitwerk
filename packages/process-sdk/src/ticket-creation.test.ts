import { expect, it } from "vitest";
import {
	parseTicketCreationConfig,
	parseTicketDestinationId,
	ticketDestinationId,
} from "./ticket-creation.js";

it("requires explicit opt-in and preserves empty label defaults", () => {
	expect(parseTicketCreationConfig({}, "Tracker")).toEqual({
		enabled: false,
		defaultLabels: ["created-by-leitwerk"],
	});
	expect(
		parseTicketCreationConfig(
			{ ticket_creation: { enabled: true, default_labels: [] } },
			"Tracker",
		),
	).toEqual({ enabled: true, defaultLabels: [] });
	expect(
		parseTicketCreationConfig(
			{ ticket_creation: { default_labels: [" triage ", "triage"] } },
			"Tracker",
		).defaultLabels,
	).toEqual(["triage"]);
});

it.each([
	{ enabled: "yes" },
	{ default_labels: null },
	{ default_labels: [""] },
	{ default_labels: "triage" },
])("rejects malformed ticket configuration %j", (ticket_creation) => {
	expect(() => parseTicketCreationConfig({ ticket_creation }, "Tracker")).toThrow(
		"Tracker ticket_creation",
	);
});

it("round-trips opaque profile names and rejects malformed destinations", () => {
	expect(parseTicketDestinationId(ticketDestinationId("team.eu/review%", 42))).toEqual({
		profile: "team.eu/review%",
		resourceId: "42",
	});
	for (const value of [".42", "team.0", "team.-1", "%.42", "team.NaN", "missing"])
		expect(() => parseTicketDestinationId(value)).toThrow("Unknown ticket destination");
});
