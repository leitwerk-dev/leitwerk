# Technical writing

## Plan a page around the reader

Leitwerk uses the [Divio documentation system](https://docs.divio.com/documentation-system/). Choose the audience first. Then choose the kind of help the reader needs on this visit.

| Kind | Reader’s question | Example in Leitwerk |
| --- | --- | --- |
| Tutorial | “Can you take me through it once?” | Run one prompt and find its response in the browser. |
| How-to guide | “How do I accomplish this task?” | Restore a backup or add a watcher to an existing extension. |
| Reference | “What exactly does this accept or return?” | Look up a configuration default or the fields of a worker message. |
| Explanation | “Why does it work this way?” | Understand why a worker must accept a start before an attempt counts. |

Each audience starts with a tutorial. Say what the reader needs on arrival, give them one concrete task, and tell them what they should see after taking an action. Introduce a term when it helps them understand what just happened or decide what to do next. End with a next task they now have the knowledge to try.

- **Browser users** arrive with access to a running installation. Keep their first visit inside the browser. Use the labels they see and offer how-to guides for decisions, settings, and recovery as those needs arise.
- **Admins** begin with a working local installation. Follow with how-to guides for deployment, login, backup, and recovery. Put runner options and configuration defaults in reference.
- **Extension developers** bring TypeScript experience. Let them run a small process, change it, and see the effect. From there, provide task guides for adding capabilities and SDK reference for exact contracts.
- **Maintainers** bring a core checkout. Give them one behavior to reproduce and trace. Lead onward to explanations of ownership and trade-offs, and references for the protocols and validation rules that constrain a change.

Keep the quick path short. A branching choice about storage belongs where an admin selects a deployment. A table of every supported storage key belongs in reference. Link between the two at the decision. Keep contributor guidance in this repository file, outside the published site.

## Writing contracts

Use the following style for API docs, semantic rules, compatibility tables, tests, and implementation notes.

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
