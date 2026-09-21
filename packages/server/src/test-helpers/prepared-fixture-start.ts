import type { ProcessInstance, ResolvedTurnStart } from "@leitwerk-dev/domain";
import type { ExtensionCatalog } from "@leitwerk-dev/extension-runtime";
import type { PiResourceBundle } from "@leitwerk-dev/worker-protocol";
import type { AppContext } from "../app.js";
import { createPiResourceBundleCache } from "../pi-resources/index.js";
import { prepareCreatedTurnStarts } from "../process-engine/turn-start-preflight.js";
import { createWrites, type TurnStartWrite } from "../process-engine/writes/writes.js";

/** Prepare fixture resources through the same provider preflight as admitted work. @internal */
export async function prepareAcceptedFixtureStart(
	ctx: AppContext,
	process: ProcessInstance,
	turnId: string,
	contributions: ExtensionCatalog["piContributions"],
): Promise<{
	/** @internal */
	start: Extract<ResolvedTurnStart, { kind: "llm" }>;
	/** @internal */
	bundle: PiResourceBundle;
}> {
	const profileId =
		process.selectedTurnModelProfileId ??
		process.defaultModelProfileId ??
		ctx.config.process_configs?.[process.processId]?.default_model_profile;
	const write: Extract<TurnStartWrite, { kind: "create" }> = {
		kind: "create",
		input: {
			instanceId: process.id,
			turnId,
			turnType: "llm",
			proposedTurnRecordId: "fixture-preflight",
			startKind: "selected_turn",
			recoveryTurnRecordId: null,
			continuation: null,
			state: {
				kind: "preparation_failed",
				requestedModelProfileId: profileId ?? null,
				providerOptions: {},
				code: "model_required",
				safeSummary: "Fixture preparation",
			},
		},
	};
	const writes = createWrites({ turnStartWrites: [write] });
	const bundleCache = createPiResourceBundleCache();
	const result = await prepareCreatedTurnStarts(
		{
			config: ctx.config,
			registry: ctx.modelProviderRegistry,
			modelStatusCache: ctx.modelStatusCache,
			piContributions: contributions,
			bundleCache,
			projects: ctx.deps.projects,
			processSkills: ctx.deps.processSkills,
		},
		{ ...process, selectedTurnId: turnId, selectedTurnModelProfileId: profileId ?? null },
		writes,
	);
	if (!result.ok) throw new Error(`Cannot prepare accepted fixture: ${result.message}`);
	const state = write.input.state;
	if (state.kind !== "starting" || state.start.kind !== "llm") {
		throw new Error(
			`Cannot prepare accepted fixture: ${state.kind === "preparation_failed" ? state.safeSummary : state.kind}`,
		);
	}
	const bundle = bundleCache.get(state.start.piResourceSnapshotDigest);
	if (!bundle) throw new Error("Prepared fixture resource bundle is missing");
	return {
		/** @internal */
		start: state.start,
		/** @internal */
		bundle,
	};
}
