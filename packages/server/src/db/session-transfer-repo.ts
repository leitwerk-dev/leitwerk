import {
	type SessionTransferAttemptWire,
	type SessionTransferPhase,
	sessionTransferAttemptStateForPhase,
} from "@leitwerk-dev/session-transfer";
import { and, eq, inArray, isNotNull, isNull, lt, notExists, or } from "drizzle-orm";
import { createOpaqueToken, hashOpaqueToken, verifyOpaqueToken } from "../auth/auth-tokens.js";
import type { LeitwerkDb } from "./database.js";
import { generateId } from "./repo-helpers.js";
import * as s from "./schema.js";

export type {
	SessionTransferAttemptState,
	SessionTransferPhase,
} from "@leitwerk-dev/session-transfer";

/** @internal */
export interface SessionTransferGrant {
	/** @internal */
	id: string;
	/** @internal */
	instanceId: string;
	/** @internal */
	tokenHash: string;
	/** @internal */
	createdAt: string;
	/** @internal */
	expiresAt: string;
	/** @internal */
	consumedAt: string | null;
	/** @internal */
	tombstoneUntil: string | null;
}

/** @internal */
export interface SessionTransferAttempt extends SessionTransferAttemptWire {
	/** @internal */
	createdAt: string;
	/** @internal */
	completedAt: string | null;
}

const ACTIVE_PHASES: SessionTransferPhase[] = [
	"queued",
	"waiting_for_execution_chain",
	"stopping_worker",
	"starting_exporter",
	"scanning",
	"ready_to_stream",
	"streaming",
	"awaiting_ack",
];

function isActivePhase(phase: SessionTransferPhase): boolean {
	return ACTIVE_PHASES.includes(phase);
}

/** @internal */
export function createSessionTransferRepo(db: LeitwerkDb) {
	const toAttempt = (
		row: typeof s.sessionTransferAttempts.$inferSelect | undefined,
	): SessionTransferAttempt | null =>
		row
			? {
					...row,
					state: sessionTransferAttemptStateForPhase(row.phase),
				}
			: null;

	return {
		/** @internal */
		createGrant(input: {
			/** @internal */
			instanceId: string;
			/** @internal */
			now: Date;
			/** @internal */
			lifetimeMs: number;
		}): {
			/** @internal */
			grant: SessionTransferGrant;
			/** @internal */
			rawToken: string;
		} {
			const rawToken = createOpaqueToken();
			const values: typeof s.sessionTransferGrants.$inferInsert = {
				id: generateId("trg"),
				instanceId: input.instanceId,
				tokenHash: hashOpaqueToken(rawToken, "hex"),
				createdAt: input.now.toISOString(),
				expiresAt: new Date(input.now.getTime() + input.lifetimeMs).toISOString(),
				consumedAt: null,
				tombstoneUntil: null,
			};
			db.insert(s.sessionTransferGrants).values(values).run();
			return { grant: this.getGrant(values.id) as SessionTransferGrant, rawToken };
		},

		/** @internal */
		getGrant(id: string): SessionTransferGrant | null {
			return (
				db.select().from(s.sessionTransferGrants).where(eq(s.sessionTransferGrants.id, id)).get() ??
				null
			);
		},

		/** @internal */
		getAttempt(id: string): SessionTransferAttempt | null {
			return toAttempt(
				db
					.select()
					.from(s.sessionTransferAttempts)
					.where(eq(s.sessionTransferAttempts.id, id))
					.get(),
			);
		},

		/** @internal */
		getActiveByInstance(instanceId: string): SessionTransferAttempt | null {
			return toAttempt(
				db
					.select()
					.from(s.sessionTransferAttempts)
					.where(
						and(
							eq(s.sessionTransferAttempts.instanceId, instanceId),
							inArray(s.sessionTransferAttempts.phase, ACTIVE_PHASES),
						),
					)
					.get(),
			);
		},

		/** @internal */
		listActive(): SessionTransferAttempt[] {
			return db
				.select()
				.from(s.sessionTransferAttempts)
				.where(inArray(s.sessionTransferAttempts.phase, ACTIVE_PHASES))
				.all()
				.map((row) => toAttempt(row) as SessionTransferAttempt);
		},

		/** @internal */
		startAttempt(input: {
			/** @internal */
			instanceId: string;
			/** @internal */
			grantId: string;
			/** @internal */
			token: string;
			/** @internal */
			now: Date;
			/** @internal */
			leaseMs: number;
			/** @internal */
			hardDeadlineMs: number;
		}):
			| {
					/** @internal */
					kind: "created";
					/** @internal */
					attempt: SessionTransferAttempt;
			  }
			| {
					/** @internal */
					kind: "not_found";
			  }
			| {
					/** @internal */
					kind: "busy";
			  } {
			const grant = this.getGrant(input.grantId);
			if (
				!grant ||
				grant.instanceId !== input.instanceId ||
				grant.consumedAt !== null ||
				Date.parse(grant.expiresAt) <= input.now.getTime() ||
				!verifyOpaqueToken(input.token, grant.tokenHash, "hex")
			) {
				return { kind: "not_found" };
			}
			if (this.getActiveByInstance(input.instanceId)) return { kind: "busy" };
			const values: typeof s.sessionTransferAttempts.$inferInsert = {
				id: generateId("tra"),
				grantId: grant.id,
				instanceId: input.instanceId,
				phase: "queued",
				createdAt: input.now.toISOString(),
				leaseUntil: new Date(input.now.getTime() + input.leaseMs).toISOString(),
				hardDeadline: new Date(input.now.getTime() + input.hardDeadlineMs).toISOString(),
				entriesTotal: null,
				logicalBytesTotal: null,
				compressedBytes: null,
				streamSha256: null,
				failureCode: null,
				completedAt: null,
			};
			try {
				db.insert(s.sessionTransferAttempts).values(values).run();
			} catch (error) {
				if ((error as Error).message.includes("uq_session_transfer_active_instance"))
					return { kind: "busy" };
				throw error;
			}
			return {
				kind: "created",
				attempt: this.getAttempt(values.id) as SessionTransferAttempt,
			};
		},

		/** @internal */
		verifyAttempt(input: {
			/** @internal */
			instanceId: string;
			/** @internal */
			grantId: string;
			/** @internal */
			attemptId: string;
			/** @internal */
			token: string;
		}): SessionTransferAttempt | null {
			const grant = this.getGrant(input.grantId);
			const attempt = this.getAttempt(input.attemptId);
			if (
				!grant ||
				!attempt ||
				grant.instanceId !== input.instanceId ||
				attempt.instanceId !== input.instanceId ||
				attempt.grantId !== grant.id
			)
				return null;
			return verifyOpaqueToken(input.token, grant.tokenHash, "hex") ? attempt : null;
		},

		/** @internal */
		updateAttempt(
			id: string,
			patch: Partial<
				Omit<SessionTransferAttempt, "id" | "grantId" | "instanceId" | "createdAt" | "state">
			>,
		): SessionTransferAttempt | null {
			db.update(s.sessionTransferAttempts)
				.set(patch)
				.where(eq(s.sessionTransferAttempts.id, id))
				.run();
			return this.getAttempt(id);
		},

		/** @internal */
		renew(
			id: string,
			input: {
				/** @internal */
				now: Date;
				/** @internal */
				leaseMs: number;
			},
		): SessionTransferAttempt | null {
			const attempt = this.getAttempt(id);
			if (!attempt || !isActivePhase(attempt.phase)) return attempt;
			const nextLease = Math.min(
				input.now.getTime() + input.leaseMs,
				Date.parse(attempt.hardDeadline),
			);
			return this.updateAttempt(id, { leaseUntil: new Date(nextLease).toISOString() });
		},

		/** @internal */
		acknowledge(input: {
			/** @internal */
			attemptId: string;
			/** @internal */
			now: Date;
			/** @internal */
			tombstoneMs: number;
		}): SessionTransferAttempt | null {
			const attempt = this.getAttempt(input.attemptId);
			if (!attempt) return null;
			if (attempt.phase === "consumed") return attempt;
			if (
				attempt.phase !== "awaiting_ack" ||
				attempt.compressedBytes === null ||
				!attempt.streamSha256
			)
				return null;
			const completedAt = input.now.toISOString();
			db.update(s.sessionTransferAttempts)
				.set({ phase: "consumed", completedAt })
				.where(
					and(
						eq(s.sessionTransferAttempts.id, attempt.id),
						eq(s.sessionTransferAttempts.phase, "awaiting_ack"),
					),
				)
				.run();
			db.update(s.sessionTransferGrants)
				.set({
					consumedAt: completedAt,
					tombstoneUntil: new Date(input.now.getTime() + input.tombstoneMs).toISOString(),
				})
				.where(
					and(
						eq(s.sessionTransferGrants.id, attempt.grantId),
						isNull(s.sessionTransferGrants.consumedAt),
					),
				)
				.run();
			return this.getAttempt(attempt.id);
		},

		/** @internal */
		revokeProcess(instanceId: string): void {
			db.delete(s.sessionTransferGrants)
				.where(eq(s.sessionTransferGrants.instanceId, instanceId))
				.run();
		},

		/** @internal */
		cleanup(now: Date): void {
			const cutoff = now.toISOString();
			db.delete(s.sessionTransferGrants)
				.where(
					and(
						or(
							and(
								isNull(s.sessionTransferGrants.consumedAt),
								lt(s.sessionTransferGrants.expiresAt, cutoff),
							),
							and(
								isNotNull(s.sessionTransferGrants.tombstoneUntil),
								lt(s.sessionTransferGrants.tombstoneUntil, cutoff),
							),
						),
						notExists(
							db
								.select({ id: s.sessionTransferAttempts.id })
								.from(s.sessionTransferAttempts)
								.where(
									and(
										eq(s.sessionTransferAttempts.grantId, s.sessionTransferGrants.id),
										inArray(s.sessionTransferAttempts.phase, ACTIVE_PHASES),
									),
								),
						),
					),
				)
				.run();
		},
	};
}
