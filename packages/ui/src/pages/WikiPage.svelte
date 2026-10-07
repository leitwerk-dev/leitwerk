<script lang="ts">
import WikiPage from "@leitwerk-dev/wiki/ui/WikiPage.svelte";
import { wikiUiHost } from "../lib/wiki.js";
import { wsStore } from "../lib/ws.svelte.js";

let { topicId = "", pageId = "" }: { topicId?: string; pageId?: string } = $props();
</script>

<WikiPage {topicId} {pageId} reconnectCount={$wsStore.reconnectCount} host={wikiUiHost} />
