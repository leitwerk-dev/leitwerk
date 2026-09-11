import type { StartupObservation } from "@leitwerk-dev/domain";
import { eq } from "drizzle-orm";
import type { LeitwerkDb } from "./database.js";
import * as s from "./schema.js";
export function createStartupObservationRepo(db: LeitwerkDb) {
	return {
		record(observation: StartupObservation): boolean {
			if (
				!Number.isFinite(Date.parse(observation.observedAt)) ||
				(observation.sourceAt !== null && !Number.isFinite(Date.parse(observation.sourceAt)))
			)
				return false;
			const lease = db
				.select()
				.from(s.workerLeases)
				.where(eq(s.workerLeases.id, observation.workerLeaseId))
				.get();
			if (!lease) return false;
			return (
				db
					.insert(s.startupObservations)
					.values({
						workerLeaseId: observation.workerLeaseId,
						milestone: observation.milestone,
						observationJson: JSON.stringify(observation),
					})
					.onConflictDoNothing()
					.run().changes > 0
			);
		},
		listByLease(workerLeaseId: string): StartupObservation[] {
			return db
				.select()
				.from(s.startupObservations)
				.where(eq(s.startupObservations.workerLeaseId, workerLeaseId))
				.all()
				.map((row) => JSON.parse(row.observationJson) as StartupObservation);
		},
	};
}
