import { randomBytes } from "node:crypto";
import { PassThrough, type Readable } from "node:stream";
import {
	type LeitwerkTransferManifestV1,
	type SessionTransferLimits,
	sessionTransferPreflightReportSchema,
	sessionTransferProgressSchema,
} from "@leitwerk-dev/session-transfer";
import type {
	ProcessStateExportHelperRelay,
	ProcessStateExportHelperReport,
} from "@leitwerk-dev/worker-runners";
import * as v from "valibot";
import { createOpaqueToken, hashOpaqueToken, verifyOpaqueToken } from "./auth/auth-tokens.js";
import type { RepositoryBundle } from "./db/repositories.js";

interface HelperRuntime {
	attemptId: string;
	credentialHash: string;
	expiresAt: number;
	expectedManifest: LeitwerkTransferManifestV1;
	preflight: ReturnType<typeof deferred<ProcessStateExportHelperReport>>;
	start: ReturnType<typeof deferred<void>>;
	upload: PassThrough;
	reported: boolean;
	streamAccepted: boolean;
	fail(error: Error): void;
}

function deferred<T>() {
	return Promise.withResolvers<T>();
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
	if (!signal) return promise;
	return Promise.race([
		promise,
		new Promise<never>((_resolve, reject) =>
			signal.addEventListener("abort", () => reject(signal.reason), { once: true }),
		),
	]);
}

function manifestAuthority(manifest: LeitwerkTransferManifestV1) {
	return {
		version: manifest.version,
		instanceId: manifest.instanceId,
		processId: manifest.processId,
		processTitle: manifest.processTitle,
		createdAt: manifest.createdAt,
		session: manifest.session,
		workspacePath: manifest.workspace.relativePath,
		projects: manifest.projects.map(({ key, relativePath }) => ({ key, relativePath })),
	};
}

function sameManifestAuthority(
	expected: LeitwerkTransferManifestV1,
	actual: LeitwerkTransferManifestV1,
): boolean {
	return JSON.stringify(manifestAuthority(expected)) === JSON.stringify(manifestAuthority(actual));
}

export function createSessionTransferHelperRelays(deps: {
	repos: Pick<RepositoryBundle, "sessionTransfers">;
	limits: SessionTransferLimits;
	now?: () => Date;
}) {
	const now = deps.now ?? (() => new Date());
	const helpers = new Map<string, HelperRuntime>();

	function active(exportId: string, credential: string): HelperRuntime | null {
		const helper = helpers.get(exportId);
		if (
			!helper ||
			helper.expiresAt <= now().getTime() ||
			!verifyOpaqueToken(credential, helper.credentialHash, "hex")
		) {
			return null;
		}
		const attempt = deps.repos.sessionTransfers.getAttempt(helper.attemptId);
		if (
			!attempt ||
			(attempt.state !== "queued" && attempt.state !== "exporting") ||
			Date.parse(attempt.leaseUntil) <= now().getTime() ||
			Date.parse(attempt.hardDeadline) <= now().getTime()
		) {
			return null;
		}
		return helper;
	}

	return {
		create(input: {
			instanceId: string;
			manifest: LeitwerkTransferManifestV1;
		}): ProcessStateExportHelperRelay {
			const attempt = deps.repos.sessionTransfers.getActiveByInstance(input.instanceId);
			if (!attempt || (attempt.state !== "queued" && attempt.state !== "exporting")) {
				throw new Error("No active session transfer can accept an export helper");
			}
			const exportId = `exp_${randomBytes(16).toString("base64url")}`;
			const credential = createOpaqueToken();
			const runtime: HelperRuntime = {
				attemptId: attempt.id,
				credentialHash: hashOpaqueToken(credential, "hex"),
				expiresAt: Date.parse(attempt.hardDeadline),
				expectedManifest: input.manifest,
				preflight: deferred<ProcessStateExportHelperReport>(),
				start: deferred<void>(),
				upload: new PassThrough(),
				reported: false,
				streamAccepted: false,
				fail: () => undefined,
			};
			runtime.preflight.promise.catch(() => undefined);
			runtime.start.promise.catch(() => undefined);
			runtime.upload.on("error", () => undefined);
			helpers.set(exportId, runtime);
			const fail = (error: Error): void => {
				if (helpers.get(exportId) !== runtime) return;
				helpers.delete(exportId);
				runtime.preflight.reject(error);
				runtime.start.reject(error);
				runtime.upload.destroy(error);
			};
			runtime.fail = fail;
			return {
				exportId,
				credential,
				waitForPreflight(signal) {
					return withAbort(runtime.preflight.promise, signal);
				},
				activateStream() {
					runtime.start.resolve(undefined);
					return runtime.upload;
				},
				fail,
			};
		},
		sweep(): void {
			const currentTime = now().getTime();
			for (const helper of helpers.values()) {
				if (helper.expiresAt <= currentTime) helper.fail(new Error("export_helper_expired"));
			}
		},
		stop(): void {
			for (const helper of helpers.values()) helper.fail(new Error("server_stopping"));
			helpers.clear();
		},
		helperSpec(input: {
			exportId: string;
			credential: string;
		}): { manifest: LeitwerkTransferManifestV1; limits: SessionTransferLimits } | null {
			const helper = active(input.exportId, input.credential);
			if (!helper || helper.reported || helper.streamAccepted) return null;
			const attempt = deps.repos.sessionTransfers.getAttempt(helper.attemptId);
			if (!attempt || (attempt.phase !== "scanning" && attempt.phase !== "starting_exporter")) {
				return null;
			}
			return {
				manifest: structuredClone(helper.expectedManifest),
				limits: { ...deps.limits },
			};
		},
		async reportHelperPreflight(input: {
			exportId: string;
			credential: string;
			report: unknown;
			signal?: AbortSignal;
		}): Promise<boolean> {
			const helper = active(input.exportId, input.credential);
			if (!helper || helper.reported || helper.streamAccepted) return false;
			const attempt = deps.repos.sessionTransfers.getAttempt(helper.attemptId);
			if (!attempt || (attempt.phase !== "scanning" && attempt.phase !== "starting_exporter")) {
				return false;
			}
			const parsed = v.safeParse(sessionTransferPreflightReportSchema, input.report);
			if (!parsed.success) return false;
			const report = parsed.output;
			if (
				report.preflight.entriesTotal > deps.limits.maxEntries ||
				report.preflight.logicalBytesTotal > deps.limits.maxLogicalBytes ||
				!sameManifestAuthority(helper.expectedManifest, report.manifest)
			) {
				return false;
			}
			helper.reported = true;
			helper.preflight.resolve(report);
			try {
				await withAbort(helper.start.promise, input.signal);
				return active(input.exportId, input.credential) === helper;
			} catch {
				return false;
			}
		},
		acceptHelperStream(input: { exportId: string; credential: string; stream: Readable }): boolean {
			const helper = active(input.exportId, input.credential);
			if (!helper?.reported || helper.streamAccepted) return false;
			const attempt = deps.repos.sessionTransfers.getAttempt(helper.attemptId);
			if (!attempt || attempt.phase !== "streaming" || attempt.state !== "exporting") return false;
			helper.streamAccepted = true;
			input.stream.on("error", (error) => helper.upload.destroy(error));
			input.stream.once("end", () => helpers.delete(input.exportId));
			input.stream.pipe(helper.upload);
			return true;
		},
		reportHelperProgress(input: {
			exportId: string;
			credential: string;
			progress: unknown;
		}): boolean {
			const helper = active(input.exportId, input.credential);
			if (!helper?.reported) return false;
			const attempt = deps.repos.sessionTransfers.getAttempt(helper.attemptId);
			const parsed = v.safeParse(sessionTransferProgressSchema, input.progress);
			if (!attempt || attempt.phase !== "streaming" || !parsed.success) return false;
			const progress = parsed.output;
			if (
				progress.entriesProcessed < attempt.entriesProcessed ||
				progress.entriesProcessed > (attempt.entriesTotal ?? 0) ||
				progress.logicalBytesProcessed < attempt.logicalBytesProcessed ||
				progress.logicalBytesProcessed > (attempt.logicalBytesTotal ?? 0)
			) {
				return false;
			}
			deps.repos.sessionTransfers.updateAttempt(attempt.id, progress);
			return true;
		},
	};
}

export type SessionTransferHelperRelays = ReturnType<typeof createSessionTransferHelperRelays>;
