<script lang="ts">
import type { LauncherReadiness } from "@leitwerk-dev/protocol/launcher-contract";

let { readiness }: { readiness: LauncherReadiness } = $props();
</script>

<span class="readiness-notice" data-section="launcher-readiness" role="status" aria-live="polite">
	<strong>{readiness.status === "blocked" ? "Configuration required" : readiness.status === "partial" ? "Some selections need configuration" : "Configuration ready"}</strong>
	{#each readiness.issues as issue}
		<span data-issue-code={issue.code}>{issue.summary} {issue.remediation}</span>
	{/each}
	<span class="connection-note">Connectivity has not been tested.</span>
</span>

<style>
	.readiness-notice {
		display: grid;
		gap: var(--space-xs);
		padding-block: var(--space-sm);
		color: var(--chronicle-text);
		font-size: 0.875rem;
		line-height: 1.5;
		overflow-wrap: anywhere;
	}
	.connection-note { color: var(--chronicle-text-muted); }
</style>
