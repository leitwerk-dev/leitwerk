import { onTestFailed, onTestFinished } from "vitest";
import { createRemoteRepoChangeFixture as createFixture } from "./remote-repo-change-fixture.js";

export {
	type RemoteRepoChangeFixture,
	remoteRepoChangeFixtureConstants,
	remoteState,
} from "./remote-repo-change-fixture.js";

/** Report detached execution positions without prompts or provider payloads. */
export async function createRemoteRepoChangeFixture(...args: Parameters<typeof createFixture>) {
	const fixture = await createFixture(...args);
	let positions: unknown;
	onTestFailed(() => console.error("Forgejo fixture positions", positions));
	onTestFinished(async () => {
		try {
			positions = fixture.harness.processes().map((process) => ({
				id: process.id,
				selectedTurnId: process.selectedTurnId,
				lifecycleStatus: process.lifecycleStatus,
				turns: fixture.harness
					.process(process.id)
					.snapshot()
					.turns.map((turn) => ({
						id: turn.id,
						turnId: turn.turnId,
						status: turn.status,
					})),
			}));
		} catch {
			/* The owning suite may already have closed the fixture. */
		}
		await fixture.close();
	});
	return fixture;
}
