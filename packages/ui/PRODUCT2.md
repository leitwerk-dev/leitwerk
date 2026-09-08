# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Software-delivery operators use Leitwerk to inspect and operate durable AI-driven processes, including understanding how model work, human decisions, and deterministic repository operations relate.

## Product Purpose

Leitwerk is a process-centric control plane around embedded Pi workers. It makes AI-driven software delivery observable and operable while the server retains durable process state. Success means an operator can understand a process's current position, history, context lineage, inputs, outputs, and available actions without interpreting internal storage mechanics.

## Positioning

Leitwerk represents multi-step AI work as one durable process instance with a persisted instance tree, code-defined turns, explicit human actions, and disposable workers. It exposes both business workflow and model-context provenance rather than presenting isolated chat sessions.

## Operating Context

Operators launch or discover processes, inspect their chronicle and process information, review model-produced plans or findings, request revisions, steer active work, recover failed turns, and finalize repository changes. Processes can include LLM, human, automatic, and external turns.

## Capabilities and Constraints

- The server is the exclusive source of truth for durable process state; workers are disposable.
- One process may contain multiple fresh or continued model contexts within one persisted instance tree.
- A fresh context supplies no prior Pi entry context, but products such as a plan may still be passed explicitly as prompt input.
- UI terminology should emphasize operator-relevant turns, context, products, and actions rather than low-level entry-storage mechanics.
- The browser UI is a Svelte 5 SPA and must remain usable across its supported responsive layouts.

## Evidence on Hand

Repository documentation defines process behavior and terminology under `docs/`. The runnable UI and process data provide real process histories; future design work must not fabricate workflow states or lineage that the server does not expose.

## Product Principles

- Make process lineage and data provenance understandable at a glance.
- Distinguish conversational continuity from explicit product or prompt handoff.
- Keep human decisions visible in the workflow without misrepresenting them as model conversations.
- Prefer business meaning over implementation and persistence terminology.
- Preserve durable process history and recovery context.

## Accessibility & Inclusion

Interactive process views should remain keyboard accessible and must not rely on color alone to communicate context boundaries, lineage, or status.
