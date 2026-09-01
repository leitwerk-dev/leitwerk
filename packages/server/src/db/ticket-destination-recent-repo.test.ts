import { afterEach, describe, expect, it, vi } from "vitest";
import { createInMemoryDatabase } from "./database.js";
import { createAllRepos } from "./repositories.js";

describe("ticket destination recent repository", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps bounded recents per operator and tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
		const repos = createAllRepos(createInMemoryDatabase());
		for (const destinationId of ["a", "b", "c", "d"]) {
			repos.ticketDestinationRecents.record({
				actorKey: "oidc:alice",
				toolName: "tracker_create_ticket",
				destinationId,
				limit: 3,
			});
			vi.advanceTimersByTime(1_000);
		}
		repos.ticketDestinationRecents.record({
			actorKey: "oidc:alice",
			toolName: "tracker_create_ticket",
			destinationId: "b",
			limit: 3,
		});
		repos.ticketDestinationRecents.record({
			actorKey: "oidc:bob",
			toolName: "tracker_create_ticket",
			destinationId: "other",
		});

		expect(
			repos.ticketDestinationRecents
				.list("oidc:alice", "tracker_create_ticket")
				.map((entry) => entry.destinationId),
		).toEqual(["b", "d", "c"]);
	});
});
