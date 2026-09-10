<script lang="ts">
import { formatPathTypeLabel } from "@leitwerk-dev/domain";
import type { ProcessUsageEstimateSnapshot } from "@leitwerk-dev/protocol";
import { onMount, tick } from "svelte";
import ChronicleUsageStats from "../chronicle/components/ChronicleUsageStats.svelte";
import type { ChronicleSelectableItem } from "../chronicle/lib/chronicle-selectable-items.js";
import type { ProcessDetailData } from "../lib/api";
import { formatRelativeTime, formatStatus } from "../lib/format";
import ProcessFlowDiagram from "../pages/ProcessFlowDiagram.svelte";
import ConversationTreeDiagram from "./ConversationTreeDiagram.svelte";
import ExternalLink from "./ExternalLink.svelte";

interface Props {
	detail: ProcessDetailData;
	processUsageEstimate: ProcessUsageEstimateSnapshot | null;
	onClose: () => void;
	railItems: readonly ChronicleSelectableItem[];
}

type ProcessInfoTab = "overview" | "launch" | "turns" | "advanced" | "conversation-tree";
type ModelTurn = ProcessDetailData["modelConfiguration"]["turns"][number];
type RunTurn = ProcessDetailData["runDetails"]["turns"][number];
type ProcessInfoTurnRow = {
	turnId: string;
	description: string;
	pathType: string;
	model: ModelTurn | null;
	run: RunTurn | null;
};

const tabs: readonly { id: ProcessInfoTab; label: string }[] = [
	{ id: "overview", label: "Overview" },
	{ id: "launch", label: "Launch inputs" },
	{ id: "turns", label: "Turns" },
	{ id: "advanced", label: "Advanced" },
	{ id: "conversation-tree", label: "Conversation tree" },
];

let { detail, processUsageEstimate, onClose, railItems }: Props = $props();
let closeButton: HTMLButtonElement | null = $state(null);
let activeTab = $state<ProcessInfoTab>("overview");

const turnRows = $derived.by((): ProcessInfoTurnRow[] => {
	const runTurnsById = new Map(detail.runDetails.turns.map((turn) => [turn.turnId, turn] as const));
	const configuredTurnIds = new Set(detail.modelConfiguration.turns.map((turn) => turn.turnId));
	return [
		...detail.modelConfiguration.turns.map((model) => {
			const run = runTurnsById.get(model.turnId) ?? null;
			return {
				turnId: model.turnId,
				description: model.description,
				pathType: model.pathType,
				model,
				run,
			};
		}),
		...detail.runDetails.turns
			.filter((run) => !configuredTurnIds.has(run.turnId))
			.map((run) => ({
				turnId: run.turnId,
				description: run.description,
				pathType: run.pathType,
				model: null,
				run,
			})),
	];
});

function hasLaunchConfiguration(detail: ProcessDetailData): boolean {
	return (
		detail.launchConfiguration.launcherId !== null ||
		detail.launchConfiguration.paramsParseError !== null ||
		detail.launchConfiguration.parameters.length > 0 ||
		detail.launchConfiguration.projects.length > 0
	);
}

function launchValue(value: string | null): string {
	return value && value.trim() !== "" ? value : "Not set";
}

function modelSourceLabel(source: "instance" | "process_config" | "default"): string {
	if (source === "instance") {
		return "Launch override";
	}
	return source === "process_config" ? "Configuration file" : "Process default";
}

function modelConfigurationIssueLabel(issue: {
	code: "invalid_turn_configs_json";
	reason: "invalid_json" | "not_object" | "turn_config_not_object";
	turnId?: string;
}): string {
	if (issue.reason === "invalid_json") return "Saved turn model configuration is not valid JSON.";
	if (issue.reason === "not_object") return "Saved turn model configuration must be an object.";
	return `Saved configuration for turn '${issue.turnId ?? "unknown"}' must be an object.`;
}

function defaultModelSourceLabel(
	source: "instance" | "process_config" | "catalog_default" | "none",
): string {
	switch (source) {
		case "instance":
			return "Launch override";
		case "process_config":
			return "Configuration file";
		case "catalog_default":
			return "Catalog default";
		default:
			return "Not configured";
	}
}

function toolNames(names: readonly string[]): string {
	return names.length > 0 ? names.join(", ") : "None";
}

function outcomeToolNames(turn: RunTurn | null): string {
	return turn ? toolNames(turn.outcomeActions.map((tool) => tool.name)) : "None";
}

function effectiveTurnModel(turn: ProcessInfoTurnRow): string {
	return (
		turn.model?.effectiveConfiguredModelProfileId ??
		detail.modelConfiguration.defaultModel.effectiveModelProfileId ??
		"No model configured"
	);
}

function turnModelSourceLabel(turn: ProcessInfoTurnRow): string {
	if (turn.model && turn.model.source !== "default") {
		return modelSourceLabel(turn.model.source);
	}
	return defaultModelSourceLabel(detail.modelConfiguration.defaultModel.source);
}

function tabId(tab: ProcessInfoTab): string {
	return `process-info-tab-${tab}`;
}

function panelId(tab: ProcessInfoTab): string {
	return `process-info-panel-${tab}`;
}

function selectTab(tab: ProcessInfoTab, focusTab = false) {
	activeTab = tab;
	void tick().then(() => {
		const overlay = document.getElementById("process-info-overlay");
		const scroller = overlay?.querySelector<HTMLElement>(".overlay-scroll");
		if (scroller) {
			scroller.scrollTop = 0;
		}
		if (focusTab) {
			document.getElementById(tabId(tab))?.focus();
		}
	});
}

function handleTabKeydown(event: KeyboardEvent, tab: ProcessInfoTab) {
	const index = tabs.findIndex((item) => item.id === tab);
	let nextIndex: number | null = null;
	if (event.key === "ArrowRight") {
		nextIndex = (index + 1) % tabs.length;
	} else if (event.key === "ArrowLeft") {
		nextIndex = (index - 1 + tabs.length) % tabs.length;
	} else if (event.key === "Home") {
		nextIndex = 0;
	} else if (event.key === "End") {
		nextIndex = tabs.length - 1;
	}
	if (nextIndex === null) {
		return;
	}
	event.preventDefault();
	selectTab(tabs[nextIndex].id, true);
}

onMount(() => {
	void tick().then(() => closeButton?.focus());
});
</script>

<div
	id="process-info-overlay"
	class="process-info-overlay"
	data-section="process-info-overlay"
	role="dialog"
	aria-modal="false"
	aria-label="Process information"
>
	<header class="overlay-header">
		<div class="overlay-heading-copy">
			<h2>Process information</h2>
			<p>
				<span>{detail.processDisplayName ?? detail.process.processId}</span>
				<span aria-hidden="true">·</span>
				<span class="mono">{detail.process.id}</span>
			</p>
		</div>
		<button
			bind:this={closeButton}
			type="button"
			class="overlay-close"
			data-pressable="true"
			onclick={() => onClose()}
			aria-label="Close process info"
		>
			Close
		</button>
	</header>

	<div class="overlay-index" role="tablist" aria-label="Process information sections">
		{#each tabs as tab (tab.id)}
			<button
				id={tabId(tab.id)}
				type="button"
				role="tab"
				class:is-active={activeTab === tab.id}
				aria-selected={activeTab === tab.id}
				aria-controls={panelId(tab.id)}
				tabindex={activeTab === tab.id ? 0 : -1}
				onclick={() => selectTab(tab.id)}
				onkeydown={(event) => handleTabKeydown(event, tab.id)}
			>
				{tab.label}
			</button>
		{/each}
	</div>

	<div class="overlay-scroll">
		<div
			id={panelId("overview")}
			class="tab-panel"
			role="tabpanel"
			aria-labelledby={tabId("overview")}
			hidden={activeTab !== "overview"}
			data-section="process-info-overview"
		>
			<section class="overlay-section" data-section="process-info-metadata">
				<div class="section-heading-copy">
					<h3>At a glance</h3>
					<p>The operational facts for this process run.</p>
				</div>
				<dl class="fact-grid">
					<div>
						<dt>Status</dt>
						<dd>{formatStatus(detail.process.lifecycleStatus)}</dd>
					</div>
					<div>
						<dt>Started</dt>
						<dd>{formatRelativeTime(detail.process.createdAt)}</dd>
					</div>
					<div>
						<dt>Last updated</dt>
						<dd>{formatRelativeTime(detail.process.updatedAt)}</dd>
					</div>
					<div>
						<dt>Default model at creation</dt>
						<dd>{detail.process.initialDefaultModelProfileId ?? "Not recorded for this process"}</dd>
					</div>
					<div>
						<dt>Process type</dt>
						<dd>{detail.processDisplayName ?? detail.process.processId}</dd>
					</div>
					<div>
						<dt>Process ID</dt>
						<dd class="mono breakable">{detail.process.id}</dd>
					</div>
				</dl>
			</section>

			{#if detail.launchConfiguration.projects.length > 0}
				<section class="overlay-section" data-section="process-info-repositories">
					<div class="section-heading-copy">
						<h3>Repositories</h3>
						<p>Source locations and branches used by this run.</p>
					</div>
					<div class="repository-list">
						{#each detail.launchConfiguration.projects as project (project.key)}
							<section class="repository-row">
								<div class="repository-heading">
									<h4>{project.key}</h4>
									<span>{project.repoLocatorKind === "remote_url" ? "Remote URL" : "Local path"}</span>
								</div>
								<p class="mono breakable">{project.repoLocator}</p>
								<dl class="branch-grid">
									<div>
										<dt>Base branch</dt>
										<dd class="mono">{project.baseBranch}</dd>
									</div>
									<div>
										<dt>Work branch</dt>
										<dd class="mono breakable">{launchValue(project.workBranch)}</dd>
									</div>
									{#if project.pipelineStatus}
										<div>
											<dt>Pipeline status</dt>
											<dd>{project.pipelineStatus}</dd>
										</div>
									{/if}
								</dl>
								{#if project.externalUrl}
									<ExternalLink
										href={project.externalUrl}
										label="Open external project"
										resourceType="project"
									/>
								{/if}
							</section>
						{/each}
					</div>
				</section>
			{/if}

			<section class="overlay-section" data-section="process-info-usage-cost">
				<div class="section-heading-copy">
					<h3>Usage and cost</h3>
					<p>Estimated totals across the LLM attempts recorded for this process.</p>
				</div>
				{#if processUsageEstimate}
					<div
						class="usage-line"
						data-completeness={processUsageEstimate.isPartial ? "partial" : "complete"}
					>
						<ChronicleUsageStats usage={processUsageEstimate.usage} size="md" />
						<span class="usage-coverage" data-section="process-info-usage-coverage">
							(<span data-field="covered-turn-count" data-value={processUsageEstimate.coveredTurnCount}
								>{processUsageEstimate.coveredTurnCount}/{processUsageEstimate.totalLlmTurnCount}
								turns with usage</span
							>{#if processUsageEstimate.missingUsageTurnCount > 0}; <span
									data-field="missing-usage-turn-count"
									data-value={processUsageEstimate.missingUsageTurnCount}
									>{processUsageEstimate.missingUsageTurnCount} missing usage</span
								>{/if}{#if processUsageEstimate.missingCostTurnCount > 0}; <span
									data-field="missing-cost-turn-count"
									data-value={processUsageEstimate.missingCostTurnCount}
									>{processUsageEstimate.missingCostTurnCount} missing cost</span
								>{/if})
						</span>
					</div>
				{:else}
					<p class="empty-copy">No Pi usage has been recorded for this process yet.</p>
				{/if}
			</section>

			{#if detail.processFlow && detail.processFlow.spine.length > 0}
				<section class="overlay-section" data-section="process-info-flow">
					<div class="section-heading-copy">
						<h3>Process flow</h3>
						<p>The expected path through this process definition.</p>
					</div>
					<ProcessFlowDiagram flow={detail.processFlow} mode="happy" expandable={true} />
				</section>
			{/if}
		</div>

		<div
			id={panelId("launch")}
			class="tab-panel"
			role="tabpanel"
			aria-labelledby={tabId("launch")}
			hidden={activeTab !== "launch"}
			data-section="process-info-launch-config"
		>
			<section class="overlay-section">
				<div class="section-heading-copy">
					<h3>Launch inputs</h3>
					<p>The values supplied when this process was created.</p>
				</div>
				{#if
					detail.modelConfiguration.state?.kind === "blocked" &&
					detail.process.lifecycleStatus !== "completed" &&
					detail.process.lifecycleStatus !== "aborted"
				}
					<div class="model-configuration-warning" role="alert">
						<strong>Saved model configuration needs attention</strong>
						<ul>
							{#each detail.modelConfiguration.state.issues as issue, index (issue.turnId ?? `${issue.reason}:${index}`)}
								<li>{modelConfigurationIssueLabel(issue)}</li>
							{/each}
						</ul>
					</div>
				{/if}
				{#if detail.launchConfiguration.paramsParseError}
					<p class="warning-copy">
						Launcher parameters could not be decoded: {detail.launchConfiguration.paramsParseError}
					</p>
				{:else if detail.launchConfiguration.parameters.length > 0}
					<dl class="detail-grid launch-parameter-grid">
						{#each detail.launchConfiguration.parameters as parameter (parameter.fieldId)}
							<dt>{parameter.label}</dt>
							<dd class="launch-config-value" data-field={parameter.fieldId}>
								{launchValue(parameter.value)}
							</dd>
						{/each}
					</dl>
				{:else}
					<p class="empty-copy">No launcher inputs were recorded for this process.</p>
				{/if}
			</section>

			{#if hasLaunchConfiguration(detail)}
				<details class="section-disclosure">
					<summary>Launcher details</summary>
					<div class="disclosure-body">
						<dl class="detail-grid">
							{#if detail.launchConfiguration.launcherLabel}
								<dt>Launcher</dt>
								<dd>{detail.launchConfiguration.launcherLabel}</dd>
							{/if}
							{#if detail.launchConfiguration.launcherId}
								<dt>Launcher ID</dt>
								<dd class="mono breakable">{detail.launchConfiguration.launcherId}</dd>
							{/if}
							{#if detail.launchConfiguration.launcherSchemaTitle}
								<dt>Form</dt>
								<dd>{detail.launchConfiguration.launcherSchemaTitle}</dd>
							{/if}
							{#if detail.launchConfiguration.projects.length > 0}
								<dt>Repository sources</dt>
								<dd>
									{detail.launchConfiguration.projects
										.map((project) => `${project.key}: ${project.repoLocatorKind === "remote_url" ? "Remote URL" : "Local path"}`)
										.join(", ")}
								</dd>
							{/if}
						</dl>
					</div>
				</details>
			{/if}
		</div>

		<div
			id={panelId("turns")}
			class="tab-panel"
			role="tabpanel"
			aria-labelledby={tabId("turns")}
			hidden={activeTab !== "turns"}
			data-section="process-info-turns"
		>
			<div class="advanced-intro">
				<h3>Turns</h3>
				<p>Models, Pi tools, and outcome schemas for each configured LLM turn.</p>
			</div>

			<section class="overlay-section" data-section="process-info-pi-tools">
				<div class="section-heading-copy">
					<h3>Available Pi tools</h3>
					<p>The process-wide union of built-in tools declared by its LLM turns.</p>
				</div>
				<div class="tool-chip-group">
					{#each detail.runDetails.availablePiToolNames as toolName (toolName)}
						<span class="tool-chip">{toolName}</span>
					{:else}
						<span class="empty-copy">No built-in Pi tools are available.</span>
					{/each}
				</div>
			</section>

			<section class="turn-tools-section" data-section="process-info-turn-tools">
				<div class="turn-tools-heading">
					<div class="section-heading-copy">
						<h3>Configured turns</h3>
						<p>Each turn shows its resolved model source, active Pi tools, and outcome tools.</p>
					</div>
					<span class="summary-detail">{turnRows.length} configured turns</span>
				</div>
				{#if turnRows.length === 0}
					<p class="empty-copy">No LLM turn details are available for this process.</p>
				{:else}
					<div class="turn-tool-stack">
						{#each turnRows as turn (turn.turnId)}
							<section class="turn-tool-section" data-turn-id={turn.turnId}>
								<header class="turn-tool-header">
									<span class="turn-tool-identity">
										<strong>{turn.description}</strong>
										<span class="mono">{turn.turnId}</span>
									</span>
									<span class="turn-model-summary">
										<strong>{effectiveTurnModel(turn)}</strong>
										<span>{turnModelSourceLabel(turn)}</span>
									</span>
									<span class="turn-tool-names">
										<span>Pi: {toolNames(turn.run?.activePiToolNames ?? [])}</span>
										<span>Outcomes: {outcomeToolNames(turn.run)}</span>
									</span>
								</header>
								<div class="turn-tool-body">
									<p class="turn-branch">{formatPathTypeLabel(turn.pathType)}</p>
									{#if !turn.run || turn.run.outcomeActions.length === 0}
										<p class="empty-copy">This turn does not declare outcome tools.</p>
									{:else}
										<ul class="outcome-tool-list">
											{#each turn.run.outcomeActions as tool (tool.name)}
												<li>
													<div class="tool-heading">
														<h4>{tool.name}</h4>
														<p>{tool.description}</p>
													</div>
													{#if tool.parameters.length > 0}
														<dl class="parameter-list">
															{#each tool.parameters as parameter (parameter.name)}
																<div class="parameter-row">
																	<dt>
																		<span class="parameter-name mono">{parameter.name}</span>
																		<span class="parameter-type">{parameter.type}</span>
																		{#if parameter.required}
																			<span class="parameter-required">required</span>
																		{/if}
																	</dt>
																	<dd>{parameter.description}</dd>
																</div>
															{/each}
														</dl>
													{:else}
														<p class="empty-copy is-inline">This tool does not take parameters.</p>
													{/if}
												</li>
											{/each}
										</ul>
									{/if}
								</div>
							</section>
						{/each}
					</div>
				{/if}
			</section>
		</div>

		<div
			id={panelId("advanced")}
			class="tab-panel"
			role="tabpanel"
			aria-labelledby={tabId("advanced")}
			hidden={activeTab !== "advanced"}
			data-section="process-info-advanced"
		>
			<div class="advanced-intro">
				<h3>Advanced configuration</h3>
				<p>System instructions and the model default retained from process creation.</p>
			</div>

			<section class="overlay-section" data-section="process-info-model-resolution">
				<div class="section-heading-copy">
					<h3>Launch model</h3>
					<p>The effective process default captured when this process was created.</p>
				</div>
				<dl class="detail-grid">
					<dt>Default at creation</dt>
					<dd>{detail.process.initialDefaultModelProfileId ?? "Not recorded for this process"}</dd>
					<dt>Explicit launch override</dt>
					<dd>{detail.modelConfiguration.defaultModel.instanceModelProfileId ?? "None"}</dd>
				</dl>
			</section>

			<details class="section-disclosure" data-section="process-info-system-prompt">
				<summary>System instructions</summary>
				<div class="disclosure-body">
					<div class="subsection">
						<h4>System prompt</h4>
						{#if detail.runDetails.systemPrompt}
							<pre class="plain-block">{detail.runDetails.systemPrompt}</pre>
						{:else}
							<p class="empty-copy">Using Pi's default system prompt.</p>
						{/if}
					</div>
					{#if detail.runDetails.appendSystemPrompt}
						<div class="subsection">
							<h4>Appended instructions</h4>
							<pre class="plain-block">{detail.runDetails.appendSystemPrompt}</pre>
						</div>
					{/if}
				</div>
			</details>
		</div>

		<div
			id={panelId("conversation-tree")}
			class="tab-panel"
			role="tabpanel"
			aria-labelledby={tabId("conversation-tree")}
			hidden={activeTab !== "conversation-tree"}
			data-section="process-info-conversation-tree"
		>
			<div class="advanced-intro">
				<h3>Conversation tree</h3>
				<p>Trace fresh contexts, inherited branches, and the inputs passed between them.</p>
			</div>
			{#if detail.instanceTree.nodes.length === 0}
				<p class="tree-status">No conversation history has been recorded yet.</p>
			{:else}
				<ConversationTreeDiagram tree={detail.instanceTree} {railItems} />
			{/if}
		</div>
	</div>
</div>

<style>
	.process-info-overlay {
		display: grid;
		grid-template-rows: auto auto minmax(0, 1fr);
		height: 100%;
		min-height: 0;
		border-radius: 20px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border-strong) 72%, white 28%);
		background: color-mix(in srgb, var(--chronicle-card-surface) 98%, white 2%);
		box-shadow: 0 20px 56px rgba(15, 23, 42, 0.18);
		overflow: hidden;
	}

	.overlay-header {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		align-items: start;
		padding: var(--space-md) 18px var(--space-sm);
	}

	.overlay-heading-copy {
		display: grid;
		gap: 4px;
		min-width: 0;
	}

	.overlay-header h2,
	.section-heading-copy h3,
	.advanced-intro h3,
	.repository-heading h4,
	.subsection h4,
	.tool-heading h4 {
		margin: 0;
		color: var(--chronicle-text);
	}

	.overlay-header h2 {
		font-size: var(--type-title-sm);
		line-height: 1.2;
		font-weight: 680;
	}

	.overlay-heading-copy p,
	.section-heading-copy p,
	.advanced-intro p,
	.repository-row p,
	.tool-heading p,
	.empty-copy {
		margin: 0;
	}

	.overlay-heading-copy p {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		font-size: var(--type-body-sm);
		color: var(--chronicle-text-muted);
	}

	.overlay-close {
		min-height: 36px;
		padding: 0 12px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 82%, white 18%);
		background: color-mix(in srgb, white 90%, var(--chronicle-panel-muted) 10%);
		font: inherit;
		font-size: 13px;
		font-weight: 620;
		color: var(--chronicle-text);
		cursor: pointer;
	}

	.overlay-index {
		display: flex;
		gap: var(--space-lg);
		min-width: 0;
		overflow-x: auto;
		padding: 0 18px;
		border-bottom: 1px solid var(--chronicle-border);
		scrollbar-width: thin;
	}

	.overlay-index button {
		position: relative;
		flex: 0 0 auto;
		min-height: 42px;
		padding: 0 2px;
		border: 0;
		background: transparent;
		color: var(--chronicle-text-muted);
		font: inherit;
		font-size: var(--type-body-sm);
		font-weight: 620;
		cursor: pointer;
	}

	.overlay-index button::after {
		content: "";
		position: absolute;
		left: 0;
		right: 0;
		bottom: -1px;
		height: 2px;
		border-radius: 999px;
		background: transparent;
	}

	.overlay-index button:hover,
	.overlay-index button.is-active {
		color: var(--chronicle-text);
	}

	.overlay-index button.is-active::after {
		background: var(--chronicle-accent);
	}

	.overlay-scroll {
		min-height: 0;
		overflow: auto;
		padding: var(--space-lg) 18px var(--space-xl);
	}

	.tab-panel {
		display: grid;
		gap: var(--space-lg);
		max-width: 880px;
		margin-inline: auto;
	}

	.tab-panel[hidden] {
		display: none;
	}

	.tree-status {
		margin: 0;
		padding: var(--space-md);
		border: 1px solid var(--chronicle-border);
		border-radius: 10px;
		color: var(--chronicle-text-muted);
	}

	.overlay-section,
	.advanced-intro {
		display: grid;
		gap: var(--space-sm);
	}

	.overlay-section + .overlay-section,
	.advanced-intro + .overlay-section {
		padding-top: var(--space-lg);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.section-heading-copy,
	.advanced-intro {
		display: grid;
		gap: 3px;
	}

	.section-heading-copy h3,
	.advanced-intro h3 {
		font-size: 15px;
		line-height: 1.3;
		font-weight: 680;
	}

	.section-heading-copy p,
	.advanced-intro p,
	.tool-heading p,
	.empty-copy {
		font-size: var(--type-body-sm);
		line-height: 1.55;
		color: var(--chronicle-text-muted);
	}

	.fact-grid,
	.branch-grid {
		margin: 0;
		display: grid;
		grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
		gap: var(--space-md) var(--space-lg);
	}

	.fact-grid > div,
	.branch-grid > div {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.fact-grid dt,
	.branch-grid dt,
	.detail-grid dt {
		font-size: 12px;
		font-weight: 620;
		color: var(--chronicle-text-muted);
	}

	.fact-grid dd,
	.branch-grid dd,
	.detail-grid dd,
	.detail-grid dt {
		margin: 0;
	}

	.fact-grid dd,
	.branch-grid dd,
	.detail-grid dd {
		font-size: 13px;
		line-height: 1.5;
		color: var(--chronicle-text);
	}

	.detail-grid {
		margin: 0;
		display: grid;
		grid-template-columns: minmax(0, 180px) minmax(0, 1fr);
		gap: 9px 16px;
	}

	.launch-parameter-grid dd {
		white-space: pre-wrap;
		word-break: break-word;
	}

	.repository-list {
		display: grid;
		gap: 0;
	}

	.repository-row {
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-md) 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.repository-row:last-child {
		padding-bottom: 0;
	}

	.repository-heading {
		display: flex;
		justify-content: space-between;
		gap: var(--space-sm);
		align-items: baseline;
	}

	.repository-heading h4 {
		font-size: 14px;
		font-weight: 670;
	}

	.repository-heading span {
		font-size: 12px;
		color: var(--chronicle-text-muted);
	}

	.repository-row > p {
		font-size: 12px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.repository-row :global(a.external-link) {
		width: fit-content;
		font-size: 13px;
	}

	.usage-line {
		display: flex;
		flex-wrap: wrap;
		align-items: baseline;
		gap: var(--space-xs);
		font-size: 12px;
		line-height: 1.5;
	}

	.usage-line :global(.usage-stats) {
		color: var(--chronicle-text);
	}

	.usage-coverage {
		color: var(--chronicle-text-muted);
	}

	.section-disclosure {
		color: var(--chronicle-text);
	}

	.section-disclosure > summary {
		cursor: pointer;
		font-size: 13px;
		font-weight: 650;
	}

	.section-disclosure {
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.section-disclosure > summary {
		position: relative;
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		align-items: baseline;
		padding: var(--space-md) 0 var(--space-md) 20px;
		list-style: none;
	}

	.section-disclosure > summary::-webkit-details-marker {
		display: none;
	}

	.section-disclosure > summary::before {
		content: "›";
		position: absolute;
		left: 2px;
		top: 50%;
		color: var(--chronicle-text-faint);
		font-size: 18px;
		font-weight: 520;
		line-height: 1;
		transform: translateY(-50%);
		transition: transform var(--duration-fast) var(--ease-out-quart);
	}

	.section-disclosure[open] > summary::before {
		transform: translateY(-50%) rotate(90deg);
	}

	.summary-detail {
		font-size: 12px;
		font-weight: 520;
		color: var(--chronicle-text-muted);
		text-align: right;
	}

	.disclosure-body {
		display: grid;
		gap: var(--space-md);
		padding: 0 0 var(--space-lg) var(--space-lg);
	}

	.model-configuration-warning {
		margin: 0;
		padding: 0.75rem 0.9rem;
		border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
		border-radius: 0.6rem;
		background: color-mix(in srgb, var(--warning) 10%, transparent);
		color: var(--text-primary);
	}

	.model-configuration-warning strong {
		color: var(--warning);
	}

	.model-configuration-warning ul {
		margin: 0.4rem 0 0;
		padding-left: 1.2rem;
	}

	.warning-copy {
		margin: 0;
		padding: 10px 12px;
		border-radius: var(--radius-sm);
		border: 1px solid color-mix(in srgb, var(--chronicle-attention) 38%, var(--chronicle-border) 62%);
		background: color-mix(in srgb, white 92%, var(--chronicle-attention) 8%);
		font-size: 13px;
		line-height: 1.5;
		color: color-mix(in srgb, var(--chronicle-attention) 78%, var(--chronicle-text) 22%);
	}

	.outcome-tool-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: grid;
		gap: var(--space-sm);
	}

	.outcome-tool-list li {
		display: grid;
		gap: var(--space-xs);
		padding-bottom: var(--space-sm);
		border-bottom: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.outcome-tool-list li:last-child {
		padding-bottom: 0;
		border-bottom: 0;
	}

	.turn-branch {
		width: fit-content;
		font-size: 12px;
		color: var(--chronicle-text-faint);
		padding: 2px 8px;
		background: color-mix(in srgb, var(--chronicle-panel-muted) 70%, transparent 30%);
		border-radius: 4px;
	}

	.subsection {
		display: grid;
		gap: var(--space-xs);
	}

	.subsection h4,
	.tool-heading h4 {
		font-size: 13px;
		font-weight: 670;
	}

	.plain-block {
		margin: 0;
		padding: 14px 16px;
		border-radius: var(--radius-md);
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
		background: color-mix(in srgb, var(--chronicle-panel-muted) 88%, white 12%);
		font-family: var(--font-mono);
		font-size: 12px;
		line-height: 1.55;
		white-space: pre-wrap;
		word-break: break-word;
		color: var(--chronicle-text);
	}

	.tool-chip-group {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
	}

	.tool-chip {
		display: inline-flex;
		align-items: center;
		min-height: 28px;
		padding: 0 10px;
		border-radius: 999px;
		border: 1px solid color-mix(in srgb, var(--chronicle-border) 80%, white 20%);
		background: color-mix(in srgb, white 90%, var(--chronicle-panel-muted) 10%);
		font-size: 12px;
		font-weight: 620;
		color: var(--chronicle-text);
	}

	.turn-tools-section {
		display: grid;
		gap: var(--space-sm);
		padding-top: var(--space-lg);
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.turn-tools-heading {
		display: flex;
		justify-content: space-between;
		gap: var(--space-md);
		align-items: start;
	}

	.turn-tool-stack {
		display: grid;
	}

	.turn-tool-section {
		display: grid;
		gap: var(--space-xs);
		padding: var(--space-md) 0;
		border-top: 1px solid color-mix(in srgb, var(--chronicle-border) 84%, white 16%);
	}

	.turn-tool-section:last-child {
		padding-bottom: 0;
	}

	.turn-tool-header {
		display: grid;
		grid-template-columns: minmax(130px, 0.7fr) minmax(180px, 0.9fr) minmax(220px, 1.2fr);
		gap: var(--space-md);
		align-items: start;
	}

	.turn-tool-identity,
	.turn-model-summary,
	.turn-tool-names {
		display: grid;
		gap: 3px;
		min-width: 0;
	}

	.turn-tool-identity strong,
	.turn-model-summary strong {
		font-size: 13px;
		font-weight: 650;
		color: var(--chronicle-text);
	}

	.turn-model-summary,
	.turn-tool-names {
		font-size: 12px;
		font-weight: 520;
		line-height: 1.45;
		color: var(--chronicle-text-muted);
	}

	.turn-tool-body {
		display: grid;
		gap: var(--space-md);
		padding: var(--space-xs) 0 0 var(--space-lg);
	}

	.parameter-list {
		margin: 0;
		display: grid;
		gap: var(--space-sm);
	}

	.parameter-row {
		display: grid;
		gap: 4px;
		padding-left: var(--space-sm);
		border-left: 1px solid color-mix(in srgb, var(--chronicle-border) 86%, white 14%);
	}

	.parameter-row dt {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-xs);
		align-items: center;
	}

	.parameter-list dd {
		margin: 0;
		font-size: 13px;
		line-height: 1.5;
		color: var(--chronicle-text-muted);
	}

	.parameter-name {
		color: var(--chronicle-text);
	}

	.parameter-type,
	.parameter-required {
		font-size: 11px;
		font-weight: 700;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--chronicle-text-muted);
	}

	.parameter-required {
		color: color-mix(in srgb, var(--chronicle-accent) 70%, var(--chronicle-text) 30%);
	}

	.empty-copy.is-inline {
		font-size: 12px;
	}

	.mono {
		font-family: var(--font-mono);
		font-size: 12px;
	}

	.breakable,
	.launch-config-value {
		white-space: pre-wrap;
		word-break: break-word;
	}

	@media (max-width: 820px) {
		.overlay-index {
			gap: var(--space-md);
		}

		.overlay-scroll {
			padding-inline: 14px;
		}

		.detail-grid {
			grid-template-columns: 1fr;
			gap: 4px;
		}

		.detail-grid dd + dt {
			margin-top: var(--space-xs);
		}

		.repository-heading,
		.section-disclosure > summary {
			align-items: start;
			flex-direction: column;
		}

		.summary-detail {
			text-align: left;
		}

		.turn-tools-heading {
			flex-direction: column;
		}

		.turn-tool-header {
			grid-template-columns: 1fr;
			gap: var(--space-xs);
		}
	}

	@media (max-width: 520px) {
		.overlay-header {
			align-items: center;
			padding-inline: 14px;
		}

		.overlay-heading-copy p .mono,
		.overlay-heading-copy p [aria-hidden="true"] {
			display: none;
		}

		.overlay-index {
			padding-inline: 14px;
		}

		.fact-grid,
		.branch-grid {
			grid-template-columns: 1fr;
		}

		.disclosure-body,
		.turn-tool-body {
			padding-left: var(--space-sm);
		}
	}
</style>
