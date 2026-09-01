import path from "node:path";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	getAgentDir,
} from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { type ParsedTransferLink, parseTransferLink } from "@leitwerk-dev/session-transfer";
import { SessionTransferClient } from "./client.js";
import { type ImportProgress, type ImportResult, importTransfer } from "./importer.js";
import { LocalTransferState } from "./local-state.js";

interface CommandOutcome {
	result?: ImportResult;
	error?: Error;
	cancelled?: boolean;
}

function formatBytes(bytes: number | null): string {
	if (bytes === null) return "—";
	if (bytes < 1024) return `${bytes} B`;
	const units = ["KiB", "MiB", "GiB", "TiB"];
	let value = bytes / 1024;
	let unit = units[0] as string;
	for (let index = 1; index < units.length && value >= 1024; index += 1) {
		value /= 1024;
		unit = units[index] as string;
	}
	return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${unit}`;
}

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

export default function leitwerkSessionTransfer(pi: ExtensionAPI) {
	const state = new LocalTransferState(getAgentDir());
	void state.reconcile().catch(() => undefined);

	pi.registerCommand("leitwerk-transfer", {
		description: "Import a Leitwerk process workspace and Pi session",
		handler: async (args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/leitwerk-transfer is available only in interactive TUI mode", "error");
				return;
			}
			await state.reconcile();
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

			const controller = new AbortController();
			let current: ImportProgress = {
				phase: "queued",
				compressedBytes: 0,
				entriesProcessed: 0,
				logicalBytesProcessed: 0,
				entriesTotal: null,
				logicalBytesTotal: null,
				finishing: false,
			};
			const outcome = await ctx.ui.custom<CommandOutcome>((tui, theme, _keybindings, done) => {
				void importTransfer({
					link,
					destination,
					state,
					signal: controller.signal,
					onProgress(progress) {
						current = progress;
						tui.requestRender();
					},
				}).then(
					(result) => done({ result }),
					(error: unknown) =>
						done({
							error: error instanceof Error ? error : new Error("Transfer failed"),
							cancelled: controller.signal.aborted,
						}),
				);
				return {
					render(width: number): string[] {
						const percent = percentage(current);
						const title = theme.fg("accent", theme.bold("Leitwerk local transfer"));
						const phase = theme.fg("text", phaseLabel(current.phase));
						const files = `${current.entriesProcessed}${current.entriesTotal === null ? "" : ` / ${current.entriesTotal}`} files`;
						const logical = `${formatBytes(current.logicalBytesProcessed)}${current.logicalBytesTotal === null ? "" : ` / ${formatBytes(current.logicalBytesTotal)}`} expanded`;
						const received = `${formatBytes(current.compressedBytes)} received`;
						const progressText =
							percent === null ? `${files} · ${logical}` : `${percent}% · ${files} · ${logical}`;
						const hint = current.finishing
							? "Final local commit cannot be cancelled"
							: "Esc cancel";
						return [
							title,
							phase,
							theme.fg("muted", progressText),
							theme.fg("muted", received),
							theme.fg("dim", hint),
						].map((line) => truncateToWidth(line, width));
					},
					handleInput(data: string): void {
						if (!current.finishing && matchesKey(data, Key.escape))
							controller.abort(new Error("Transfer cancelled"));
					},
					invalidate(): void {},
				};
			});

			if (!outcome || outcome.cancelled) {
				ctx.ui.notify(
					"Transfer cancelled. The link can be retried while it remains valid.",
					"info",
				);
				return;
			}
			if (outcome.error || !outcome.result) {
				ctx.ui.notify(outcome.error?.message ?? "Transfer failed", "error");
				return;
			}
			await switchImportedSession(ctx, outcome.result.sessionPath);
		},
	});
}
