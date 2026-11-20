import { parseStrictInstanceTurnConfigsJson, trimToNull } from "@leitwerk-dev/domain";
import { parseFutureActionPayloadJson, parseFutureLaunchPayloadJson } from "@leitwerk-dev/protocol";
import type { DashboardConfigurationIssue } from "@leitwerk-dev/protocol/http-contracts";
import { presentProcessModelPolicyFailure } from "./process-model-policy-presenter.js";
import type { ProcessWatcherServiceLike } from "./process-watcher-registry.js";
import type { RouteDeps } from "./routes/process-route-helpers.js";

type IssueSource = DashboardConfigurationIssue["sources"][number];

/** @internal */
export type DashboardModelIssueDeps = Pick<
	RouteDeps,
	| "config"
	| "processModelPolicy"
	| "modelStatusCache"
	| "processes"
	| "futureExecutions"
	| "scopedSettingsService"
	| "processGraphs"
> & { /** @internal */ processWatchers?: ProcessWatcherServiceLike };

/** Reads cached availability and model references; never resolves launches or process contexts. @internal */
export function buildDashboardModelIssues(
	deps: DashboardModelIssueDeps,
): DashboardConfigurationIssue[] {
	const issues = new Map<string, DashboardConfigurationIssue>();
	const availability = deps.modelStatusCache.snapshot();
	function add(
		code: string,
		key: string,
		message: string,
		source: IssueSource,
		severity?: "warning" | "error",
	) {
		const id = JSON.stringify([code, key]);
		const issue = issues.get(id) ?? {
			id,
			code,
			severity: severity ?? (code === "model_stale" ? ("warning" as const) : ("error" as const)),
			message,
			sources: [],
		};
		if (!issue.sources.some((item) => item.label === source.label && item.href === source.href))
			issue.sources.push(source);
		issues.set(id, issue);
	}
	function check(
		profileId: string | null | undefined,
		source: IssueSource,
		processId = "",
		turnId?: string,
		preference = false,
	) {
		const id = trimToNull(profileId);
		if (!id) return;
		const result = deps.processModelPolicy.evaluate({
			kind: "runtime_selection",
			target: turnId ? { kind: "turn", turnId } : { kind: "process_default" },
			processId,
			selection: {
				modelProfileId: id,
				provenance: { kind: "explicit", source: "instance_default" },
			},
			availability,
		});
		if (result.ok || (preference && result.code === "model_profile_not_allowed")) return;
		const key = result.code === "model_profile_not_allowed" ? JSON.stringify([id, processId]) : id;
		const message = presentProcessModelPolicyFailure(result);
		add(
			result.code,
			key,
			result.code === "model_stale" || result.code === "model_unavailable"
				? `${id}: ${message}`
				: message,
			source,
		);
	}
	function checkPersisted(
		input: {
			processId: string;
			defaultModelProfileId?: string | null;
			turnConfigsJson?: string | null;
			selectedTurnModelProfileId?: string | null;
		},
		source: IssueSource,
	) {
		check(
			input.defaultModelProfileId,
			{ ...source, label: `${source.label}: default model` },
			input.processId,
			undefined,
			true,
		);
		check(
			input.selectedTurnModelProfileId,
			{ ...source, label: `${source.label}: selected step` },
			input.processId,
		);
		const parsed = parseStrictInstanceTurnConfigsJson(
			input.processId,
			input.turnConfigsJson ?? null,
		);
		if (!parsed.ok) {
			add(
				"invalid_model_configuration",
				source.href ?? source.label,
				"Saved step model configuration is invalid.",
				source,
			);
			return;
		}
		for (const [turnId, config] of Object.entries(parsed.value))
			check(
				config.modelProfileId,
				{ ...source, label: `${source.label}: ${turnId}` },
				input.processId,
				turnId,
			);
	}
	for (const processId of deps.processGraphs.keys()) {
		check(
			deps.config?.pi.process_title_generation.model_profile,
			{ label: `${processId}: title generation`, href: null },
			processId,
		);
		const preview = deps.processModelPolicy.project({
			kind: "launcher_preview",
			processId,
			modelConfig: {},
			availability,
		});
		for (const turn of preview.turns) {
			if (
				!turn.effective.error &&
				(turn.effective.ranking?.kind === "cost_id" ||
					(turn.effective.ranking?.tiedProfileIds.length ?? 0) > 1)
			)
				add(
					"automatic_model_tiebreak",
					`${processId}/${turn.turnId}`,
					`Selected '${turn.effective.profile?.id}' by ${turn.effective.ranking?.kind === "cost_id" ? "cost group and profile ID" : `cost group and profile ID among equal-specificity defaults: ${turn.effective.ranking?.tiedProfileIds.join(", ")}`}`,
					{ label: `${processId}: ${turn.turnId}`, href: null },
					"warning",
				);
			if (turn.effective.error)
				add(
					"model_policy_blocked",
					turn.effective.profile?.id ?? `${processId}/${turn.turnId}`,
					turn.effective.error,
					{ label: `${processId}: ${turn.turnId}`, href: null },
				);
		}
	}
	const config = deps.config;
	if (config) {
		for (const profile of config.pi.model_profiles)
			check(profile.id, { label: `pi.model_profiles (${profile.id})`, href: null });
		check(config.pi.default_model_profile, { label: "pi.default_model_profile", href: null });
		check(config.pi.process_title_generation.model_profile, {
			label: "pi.process_title_generation.model_profile",
			href: null,
		});
		for (const [processId, processConfig] of Object.entries(config.process_configs ?? {})) {
			const prefix = `process_configs.${processId}`;
			check(
				processConfig.default_model_profile,
				{ label: `${prefix}.default_model_profile`, href: null },
				processId,
				undefined,
				true,
			);
			for (const [turnId, turnConfig] of Object.entries(processConfig.turn_configs ?? {}))
				check(
					turnConfig.model_profile,
					{ label: `${prefix}.turn_configs.${turnId}.model_profile`, href: null },
					processId,
					turnId,
					true,
				);
		}
	}
	for (const reference of deps.scopedSettingsService?.modelReferences() ?? []) {
		const source = {
			label: `${reference.label} (${reference.key})`,
			href: reference.subjectId
				? `/settings?scope=${encodeURIComponent(reference.subjectId)}`
				: null,
		};
		if (reference.invalid)
			add(
				"invalid_model_configuration",
				`${reference.subjectId}:${reference.key}`,
				"Saved model setting is invalid. Correct it in Settings.",
				source,
			);
		else check(reference.modelProfileId, source);
	}
	for (const watcher of deps.processWatchers?.listAll() ?? []) {
		const source = { label: watcher.configPath, href: "/watchers" };
		check(
			watcher.launchModelConfig.defaultModelProfileId,
			source,
			watcher.processId,
			undefined,
			true,
		);
		for (const [turnId, turnConfig] of Object.entries(watcher.launchModelConfig.turnConfigs ?? {}))
			check(
				turnConfig.modelProfileId,
				{ ...source, label: `${source.label}: ${turnId}` },
				watcher.processId,
				turnId,
			);
	}
	for (const process of deps.processes.listModelConfigurations()) {
		checkPersisted(
			{
				...process,
				selectedTurnModelProfileId: process.selectedTurnId
					? process.selectedTurnModelProfileId
					: null,
			},
			{
				label: process.title ?? process.id,
				href: `/processes/${encodeURIComponent(process.id)}?inspect=process&section=inputs`,
			},
		);
	}
	for (const execution of deps.futureExecutions.listAll()) {
		const source = {
			label: `Scheduled ${execution.kind}: ${execution.id}`,
			href:
				execution.kind === "launch"
					? `/future-launches/${encodeURIComponent(execution.id)}`
					: `/processes/${encodeURIComponent(execution.instanceId ?? "")}`,
		};
		check(execution.modelSelection?.modelProfileId, source, execution.processId);
		const parsed =
			execution.kind === "launch"
				? parseFutureLaunchPayloadJson(execution.payloadJson)
				: parseFutureActionPayloadJson(execution.payloadJson);
		if (!parsed.ok)
			add(
				"invalid_model_configuration",
				execution.id,
				`Scheduled ${execution.kind} configuration is invalid.`,
				source,
			);
		else if ("launchPlan" in parsed.value)
			checkPersisted(parsed.value.launchPlan.processInput, source);
		else check(parsed.value.nextTurnModelProfileId, source, execution.processId);
	}
	for (const issue of issues.values()) issue.sources.sort((a, b) => a.label.localeCompare(b.label));
	return [...issues.values()].sort(
		(a, b) =>
			(a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
			a.message.localeCompare(b.message) ||
			a.id.localeCompare(b.id),
	);
}
