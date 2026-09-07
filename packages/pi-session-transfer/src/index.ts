import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	formatSize,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { CancellableLoader } from "@earendil-works/pi-tui";
import { type ParsedTransferLink, parseTransferLink } from "@leitwerk-dev/session-transfer";
import { SessionTransferClient } from "./client.js";
import { type ImportProgress, type ImportResult, importTransfer } from "./importer.js";
import { LocalTransferState } from "./local-state.js";

function phaseLabel(phase: string): string {
	return (
		{
			queued: "Queued",
			waiting_for_execution_chain: "Waiting for accepted work",
			stopping_worker: "Stopping the idle worker",
			starting_exporter: "Starting the read-only exporter",
			scanning: "Checking portable files",
			ready_to_stream: "Ready to stream",
			streaming: "Copying workspace and session",
			validating_local: "Validating local import",
			finishing_import: "Finishing import…",
		}[phase] ?? phase.replaceAll("_", " ")
	);
}

function percentage(progress: ImportProgress): number | null {
	if (progress.logicalBytesTotal && progress.logicalBytesTotal > 0) {
		return Math.min(
			100,
			Math.floor((progress.logicalBytesProcessed / progress.logicalBytesTotal) * 100),
		);
	}
	if (progress.entriesTotal && progress.entriesTotal > 0) {
		return Math.min(100, Math.floor((progress.entriesProcessed / progress.entriesTotal) * 100));
	}
	return null;
}

function progressMessage(progress: ImportProgress): string {
	const percent = percentage(progress);
	const files = `${progress.entriesProcessed}${progress.entriesTotal === null ? "" : ` / ${progress.entriesTotal}`} files`;
	const logical = `${formatSize(progress.logicalBytesProcessed)}${progress.logicalBytesTotal === null ? "" : ` / ${formatSize(progress.logicalBytesTotal)}`} expanded`;
	const received = `${formatSize(progress.compressedBytes)} received`;
	return `${phaseLabel(progress.phase)} · ${percent === null ? "" : `${percent}% · `}${files} · ${logical} · ${received}`;
}

async function switchImportedSession(
	ctx: ExtensionCommandContext,
	sessionPath: string,
): Promise<void> {
	const switched = await ctx.switchSession(sessionPath, {
		withSession: async (replacementCtx) => {
			replacementCtx.ui.notify(
				"Leitwerk process imported. Local Pi tools and resources are active.",
				"info",
			);
		},
	});
	if (switched.cancelled) {
		ctx.ui.notify(
			`Import complete. Session switch was cancelled; open it with /resume: ${sessionPath}`,
			"info",
		);
	}
}

export default async function leitwerkSessionTransfer(pi: ExtensionAPI) {
	const state = new LocalTransferState(getAgentDir());
	await state.reconcile();

	pi.registerCommand("leitwerk-transfer", {
		description: "Import a Leitwerk process workspace and Pi session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/leitwerk-transfer is available only in interactive TUI mode", "error");
				return;
			}
			const rawLink =
				args.trim() ||
				(await ctx.ui.input(
					"Leitwerk transfer link",
					"https://leitwerk.example/api/session-transfers/…#token=…",
				));
			if (!rawLink) return;
			let link: ParsedTransferLink;
			try {
				link = parseTransferLink(rawLink);
			} catch (error) {
				ctx.ui.notify(error instanceof Error ? error.message : "Invalid transfer link", "error");
				return;
			}

			const originWarning = `${link.origin} will receive the bearer credential and stream files into this Pi process. Continue only if you recognize it.`;
			const receipt = await state.receipt(link);
			if (receipt) {
				if (
					!(await ctx.ui.confirm(
						"Import already complete",
						`Use the imported session at ${receipt.sessionPath}? ${originWarning}`,
					))
				) {
					return;
				}
				try {
					await new SessionTransferClient(link).acknowledge(
						receipt.attemptId,
						AbortSignal.timeout(30_000),
					);
				} catch (error) {
					ctx.ui.notify(
						error instanceof Error ? error.message : "Could not reconcile the completed import",
						"error",
					);
					return;
				}
				await switchImportedSession(ctx, receipt.sessionPath);
				return;
			}

			const defaultDestination = path.join(ctx.cwd, link.instanceId);
			const selectedDestination = await ctx.ui.input(
				"New destination directory",
				defaultDestination,
			);
			if (!selectedDestination) return;
			const destination = path.resolve(ctx.cwd, selectedDestination);
			await ctx.waitForIdle();
			if (
				!(await ctx.ui.confirm(
					"Import Leitwerk process?",
					`Create ${destination}, copy the retained workspace, and import its Pi conversation? ${originWarning}`,
				))
			)
				return;

			let finishing = false;
			const outcome = await ctx.ui.custom<ImportResult | Error | null>(
				(tui, theme, _keybindings, done) => {
					const loader = new CancellableLoader(
						tui,
						(s) => theme.fg("accent", s),
						(s) => theme.fg("muted", s),
						"Starting transfer…",
					);
					loader.onAbort = () => {
						if (!finishing) done(null);
					};
					void importTransfer({
						link,
						destination,
						state,
						signal: loader.signal,
						onProgress(progress) {
							finishing = progress.finishing;
							loader.setMessage(progressMessage(progress));
						},
					}).then(
						(result) => done(result),
						(error: unknown) => done(error instanceof Error ? error : new Error("Transfer failed")),
					);
					return loader;
				},
			);

			if (!outcome) {
				ctx.ui.notify(
					"Transfer cancelled. The link can be retried while it remains valid.",
					"info",
				);
				return;
			}
			if (outcome instanceof Error) {
				ctx.ui.notify(outcome.message, "error");
				return;
			}
			await switchImportedSession(ctx, outcome.sessionPath);
		},
	});
}
