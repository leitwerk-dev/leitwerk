<script lang="ts">
import type { InspectionTraceMessage, TurnTraceSnapshot } from "@leitwerk-dev/protocol";
import type { ToolCallRendererDefinition } from "@leitwerk-dev/protocol/tool-renderer-contract";
import ChronicleMarkdown from "../../../chronicle/components/ChronicleMarkdown.svelte";
import ChronicleThinkingText from "../../../chronicle/components/ChronicleThinkingText.svelte";
import ChronicleToolCallItem from "../../../chronicle/components/ChronicleToolCallItem.svelte";

let {
	message,
	live = null,
	toolRendererIndex = {},
	onLink,
}: {
	message: InspectionTraceMessage;
	live?: TurnTraceSnapshot | null;
	toolRendererIndex?: Record<string, ToolCallRendererDefinition>;
	onLink?: (id: string) => void;
} = $props();
let copied = $state(false);
async function copy() {
	try {
		await navigator.clipboard.writeText(
			message.blocks
				.map((block) => (block.content.type === "text" ? block.content.text : ""))
				.join("\n"),
		);
		copied = true;
	} catch {
		copied = false;
	}
}
const label = $derived(
	message.role === "user"
		? "Input"
		: message.role === "assistant"
			? "Assistant"
			: message.role === "toolResult"
				? `Tool result · ${message.toolName ?? "tool"}`
				: message.role.replaceAll("_", " "),
);
</script>
<article class="message" data-inspection-item={message.id} data-role={message.role}>
  <header><h3>{label}{#if message.isError} · Failed{/if}</h3><div class="message-actions">{#if message.role === "user"}<button class="item-link" onclick={copy} aria-label="Copy input message">{copied ? "Copied" : "Copy"}</button>{/if}{#if onLink}<button class="item-link" onclick={() => onLink?.(message.id)} aria-label={`Link to ${label}`}>Link</button>{/if}</div></header>
  {#if message.id.startsWith("event:")}<p class="block-label">Recorded activity · session entry correlation unavailable</p>{/if}
  {#each message.blocks as block (block.id)}
    <div data-inspection-item={block.id} class="message-block">
      {#if block.content.type === "thinking"}
        <p class="block-label">Recorded reasoning{#if block.content.redacted} · redacted{/if}</p>
        <ChronicleThinkingText text={block.content.thinking} />
      {:else if block.content.type === "text"}
        {#if message.role === "toolResult"}<pre>{block.content.text}</pre>{:else}<ChronicleMarkdown markdown={block.content.text} />{/if}
      {:else if block.content.type === "toolCall"}
        {@const recorded = live?.toolCalls.find(tool => block.content.type === "toolCall" && tool.toolCallId === block.content.id)}
        <ChronicleToolCallItem toolCall={recorded ?? {toolCallId: block.content.id, toolName: block.content.name, arguments: block.content.arguments, status: "completed", startedAt: message.timestamp, completedAt: null, resultText: null, truncated: false, isError: false}} {toolRendererIndex} />
      {:else if block.content.type === "image"}
        {#if ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(block.content.mimeType)}<img src={`data:${block.content.mimeType};base64,${block.content.data}`} alt="Recorded model input" />{:else}<p>Recorded image format is not supported for display.</p>{/if}
      {/if}
    </div>
  {/each}
</article>
<style>
.message {padding:var(--space-lg) 0; border-bottom:1px solid var(--chronicle-border); min-width:0; overflow-wrap:anywhere;}
.message-actions {display:flex; gap:var(--space-sm);}
header {display:flex; align-items:baseline; justify-content:space-between; gap:var(--space-md); margin-bottom:var(--space-sm);} h3 {margin:0; font-size:var(--type-body); font-weight:650;}
.message-block + .message-block {margin-top:var(--space-md);} .block-label {margin:0 0 var(--space-xs); color:var(--chronicle-text-muted); font-size:var(--type-caption);}
pre {white-space:pre-wrap; overflow-wrap:anywhere; margin:0; padding:var(--space-md); background:var(--chronicle-panel-muted); border-radius:var(--radius-sm); font-size:var(--type-caption); line-height:1.65; max-height:32rem; overflow:auto;}
img {max-width:100%; max-height:32rem; object-fit:contain;} .item-link {border:0; padding:var(--space-xs); background:transparent; color:var(--chronicle-accent); font:inherit; font-size:var(--type-caption); cursor:pointer;}
.item-link:focus-visible {outline:2px solid var(--chronicle-accent); outline-offset:2px;}
</style>
