import { afterEach, describe, expect, it, vi } from "vitest";
import { createOwnedInMemoryDatabase as createInMemoryDatabase } from "../test-helpers/owned-test-deps.js";
import { createAllRepos } from "./repositories.js";

describe("ticket destination recent repository", () => {
	afterEach(() => vi.useRealTimers());

	it("keeps bounded recents per operator and tool", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-23T00:00:00.000Z"));
		const repos = createAllRepos(createInMemoryDatabase());
		const otherActor = repos.ticketDestinationRecents.record({
			actorKey: "oidc:bob",
			toolName: "tracker_create_ticket",
			destinationId: "other",
		});
		const otherTool = repos.ticketDestinationRecents.record({
			actorKey: "oidc:alice",
			toolName: "another_tool",
			destinationId: "other-tool",
		});
		vi.advanceTimersByTime(1000);
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

		expect(
			repos.ticketDestinationRecents
				.list("oidc:alice", "tracker_create_ticket")
				.map((entry) => entry.destinationId),
		).toEqual(["b", "d", "c"]);
		expect(repos.ticketDestinationRecents.list("oidc:bob", "tracker_create_ticket")).toEqual([
			otherActor,
		]);
		expect(repos.ticketDestinationRecents.list("oidc:alice", "another_tool")).toEqual([otherTool]);
	});
});
