# Topic solution wikis

[`@leitwerk-dev/wiki`](../packages/wiki/README.md) owns solution wiki storage,
tools, HTTP handlers, and browser views. The application supplies database,
authentication, tool registration, and UI services. Process SDK exports contain
no wiki-specific contracts.

Share only reusable solutions that help another process in the topic and add
knowledge absent from the current ticket description and shared source requirement.
Explain applicability, reasoning, limitations, and evidence. Repeating ticket
instructions or publishing progress reports does not qualify. Sharing nothing
is valid. Novelty is assessed by the contributor, without an extra LLM review.

Processes bind explicitly to topics. Jira integrations use installation URL and
immutable issue ID: subtasks share their direct parent's topic, and other
epic-linked tickets share their epic's topic. Provider adapters validate retained
bindings and refresh source requirements. Any process can use a topic without Jira.

The [package reference](../packages/wiki/README.md) documents tool parameters,
HTTP contracts, hosting, evidence status, revisions, deletion, and compatibility.
Wiki content is untrusted evidence and never overrides process requirements.
