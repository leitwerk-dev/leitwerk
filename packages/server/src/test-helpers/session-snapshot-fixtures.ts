import type { AppContext } from "../app.js";
import { createAllRepos } from "../db/repositories.js";
import { createFileBackedProcessSessionSnapshotStore } from "../process-session-store.js";
import { createProjectedSessionSnapshotStore } from "../session-summary-projection.js";

/** Accept fixture snapshots through the same persisted projection as worker uploads. */
export async function writeProcessSessionSnapshot(
	ctx: Pick<AppContext, "db" | "config">,
	instanceId: string,
	entries: readonly unknown[],
): Promise<void> {
	const store = createProjectedSessionSnapshotStore(
		createFileBackedProcessSessionSnapshotStore(ctx.config.storage.tree_files_dir),
		createAllRepos(ctx.db),
	);
	await store.writeSnapshot(
		instanceId,
		`${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`,
	);
}
