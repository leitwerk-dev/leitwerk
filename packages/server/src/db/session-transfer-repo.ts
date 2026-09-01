import type {
	SessionTransferAttemptState,
	SessionTransferAttemptWire,
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

export interface SessionTransferGrant {
	id: string;
	instanceId: string;
	tokenHash: string;
	createdAt: string;
	expiresAt: string;
	consumedAt: string | null;
	tombstoneUntil: string | null;
}

export interface SessionTransferAttempt extends SessionTransferAttemptWire {
	createdAt: string;
	completedAt: string | null;
}

const ACTIVE_STATES: SessionTransferAttemptState[] = ["queued", "exporting", "awaiting_ack"];

export function createSessionTransferRepo(db: LeitwerkDb) {
	return {
		createGrant(input: { instanceId: string; now: Date; lifetimeMs: number }): {
			grant: SessionTransferGrant;
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

		getGrant(id: string): SessionTransferGrant | null {
			return (
				db.select().from(s.sessionTransferGrants).where(eq(s.sessionTransferGrants.id, id)).get() ??
				null
			);
		},

		getAttempt(id: string): SessionTransferAttempt | null {
			return (
				db
					.select()
					.from(s.sessionTransferAttempts)
					.where(eq(s.sessionTransferAttempts.id, id))
					.get() ?? null
			);
		},

		getActiveByInstance(instanceId: string): SessionTransferAttempt | null {
			return (
				db
					.select()
					.from(s.sessionTransferAttempts)
					.where(
						and(
							eq(s.sessionTransferAttempts.instanceId, instanceId),
							inArray(s.sessionTransferAttempts.state, ACTIVE_STATES),
						),
					)
					.get() ?? null
			);
		},

		listActive(): SessionTransferAttempt[] {
			return db
				.select()
				.from(s.sessionTransferAttempts)
				.where(inArray(s.sessionTransferAttempts.state, ACTIVE_STATES))
				.all();
		},

		startAttempt(input: {
			instanceId: string;
			grantId: string;
			token: string;
			now: Date;
			leaseMs: number;
			hardDeadlineMs: number;
		}):
			| { kind: "created"; attempt: SessionTransferAttempt }
			| { kind: "not_found" }
			| { kind: "busy" } {
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
				state: "queued",
				phase: "queued",
				createdAt: input.now.toISOString(),
				leaseUntil: new Date(input.now.getTime() + input.leaseMs).toISOString(),
				hardDeadline: new Date(input.now.getTime() + input.hardDeadlineMs).toISOString(),
				entriesTotal: null,
				entriesProcessed: 0,
				logicalBytesTotal: null,
				logicalBytesProcessed: 0,
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

		verifyAttempt(input: {
			instanceId: string;
			grantId: string;
			attemptId: string;
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

		updateAttempt(
			id: string,
			patch: Partial<Omit<SessionTransferAttempt, "id" | "grantId" | "instanceId" | "createdAt">>,
		): SessionTransferAttempt | null {
			db.update(s.sessionTransferAttempts)
				.set(patch)
				.where(eq(s.sessionTransferAttempts.id, id))
				.run();
			return this.getAttempt(id);
		},

		renew(id: string, input: { now: Date; leaseMs: number }): SessionTransferAttempt | null {
			const attempt = this.getAttempt(id);
			if (!attempt || !ACTIVE_STATES.includes(attempt.state)) return attempt;
			const nextLease = Math.min(
				input.now.getTime() + input.leaseMs,
				Date.parse(attempt.hardDeadline),
			);
			return this.updateAttempt(id, { leaseUntil: new Date(nextLease).toISOString() });
		},

		acknowledge(input: {
			attemptId: string;
			now: Date;
			tombstoneMs: number;
		}): SessionTransferAttempt | null {
			const attempt = this.getAttempt(input.attemptId);
			if (!attempt) return null;
			if (attempt.state === "consumed") return attempt;
			if (
				attempt.state !== "awaiting_ack" ||
				attempt.compressedBytes === null ||
				!attempt.streamSha256
			)
				return null;
			const completedAt = input.now.toISOString();
			db.update(s.sessionTransferAttempts)
				.set({ state: "consumed", phase: "consumed", completedAt })
				.where(
					and(
						eq(s.sessionTransferAttempts.id, attempt.id),
						eq(s.sessionTransferAttempts.state, "awaiting_ack"),
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

		revokeProcess(instanceId: string): void {
			db.delete(s.sessionTransferGrants)
				.where(eq(s.sessionTransferGrants.instanceId, instanceId))
				.run();
		},

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
										inArray(s.sessionTransferAttempts.state, ACTIVE_STATES),
									),
								),
						),
					),
				)
				.run();
		},
	};
}
