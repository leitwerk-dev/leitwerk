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
	function add(code: string, key: string, message: string, source: IssueSource) {
		const id = JSON.stringify([code, key]);
		const issue = issues.get(id) ?? {
			id,
			code,
			severity: code === "model_stale" ? ("warning" as const) : ("error" as const),
			message,
			sources: [],
		};
		if (!issue.sources.some((item) => item.label === source.label && item.href === source.href))
			issue.sources.push(source);
		issues.set(id, issue);
	}
	function check(profileId: string | null | undefined, source: IssueSource, processId = "") {
		const id = trimToNull(profileId);
		if (!id) return;
		const result = deps.processModelPolicy.evaluate({
			kind: "runtime_selection",
			processId,
			selection: {
				modelProfileId: id,
				provenance: { kind: "explicit", source: "instance_default" },
			},
			availability,
		});
		if (result.ok) return;
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
			);
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
			);
			for (const [turnId, turnConfig] of Object.entries(processConfig.turn_configs ?? {}))
				check(
					turnConfig.model_profile,
					{ label: `${prefix}.turn_configs.${turnId}.model_profile`, href: null },
					processId,
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
		check(watcher.launchModelConfig.defaultModelProfileId, source, watcher.processId);
		for (const [turnId, turnConfig] of Object.entries(watcher.launchModelConfig.turnConfigs ?? {}))
			check(
				turnConfig.modelProfileId,
				{ ...source, label: `${source.label}: ${turnId}` },
				watcher.processId,
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
		if (execution.kind === "launch") {
			const parsed = parseFutureLaunchPayloadJson(execution.payloadJson);
			if (parsed.ok) checkPersisted(parsed.value.launchPlan.processInput, source);
			else
				add(
					"invalid_model_configuration",
					execution.id,
					"Scheduled launch configuration is invalid.",
					source,
				);
		} else {
			const parsed = parseFutureActionPayloadJson(execution.payloadJson);
			if (parsed.ok) check(parsed.value.nextTurnModelProfileId, source, execution.processId);
			else
				add(
					"invalid_model_configuration",
					execution.id,
					"Scheduled action configuration is invalid.",
					source,
				);
		}
	}
	return [...issues.values()]
		.map((issue) => ({
			...issue,
			sources: issue.sources.sort((a, b) => a.label.localeCompare(b.label)),
		}))
		.sort(
			(a, b) =>
				(a.severity === b.severity ? 0 : a.severity === "error" ? -1 : 1) ||
				a.message.localeCompare(b.message) ||
				a.id.localeCompare(b.id),
		);
}
