<script lang="ts">
import {
	type ApprovalConfirmation,
	approvalConfirmationDetail,
	approvalConfirmationTitle,
} from "../lib/action-bindings.js";

let { confirmation }: { confirmation: ApprovalConfirmation } = $props();
</script>

<div class="confirmation" data-section="approval-confirmation">
	<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/></svg>
	<div>
		<strong>{approvalConfirmationTitle(confirmation)}</strong>
		<p>{approvalConfirmationDetail(confirmation)}</p>
	</div>
</div>

<style>
	.confirmation {
		display: flex;
		align-items: flex-start;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md);
		border: 1px solid #b8d5c3;
		border-radius: 10px;
		background: #f3faf5;
		color: #20533a;
		font-size: var(--type-body-sm);
		line-height: 1.5;
	}

	svg { flex-shrink: 0; }
	p { margin: 0; overflow-wrap: anywhere; }
</style>
