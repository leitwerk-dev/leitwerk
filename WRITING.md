# Technical writing

Use this style for API docs, semantic rules, compatibility tables, tests, and implementation notes.

## Influences

- Rob Pike
- Brian Kernighan

## Tone

- Concise
- Direct
- Precise
- Practical
- Minimal ornamentation

## Scope

Document contracts, user-visible behavior, operational requirements, and non-obvious
constraints. Do not narrate the implementation or maintain a prose inventory of
tests, helpers, internal environment variables, or cleanup mechanics.

Update documentation when a change alters what users or maintainers need to know,
not merely because code changed. Keep implementation rationale near the code.
Tests are the source of truth for individual coverage cases.

## Example

> GOSUB pushes the next statement position onto the call stack. RETURN resumes from that position. Returning with an empty stack is an error.
