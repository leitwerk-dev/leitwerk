---
name: review-stack
description: Stack review status for maintainers. Use when inspecting a PR stack, recording local validation, or when code-review needs stack state.
---

For a request limited to local validation, follow [Local validation](validation.md) directly. For stack status or review inputs, follow the steps below.

## 1. Capture the stack

Identify the top PR from the request or GitHub metadata. Resolve ambiguous stack membership with the maintainer before choosing a parent.

From the repository root, set `stack_pr` to the top PR URL and run:

```bash
npm run --silent review:stack -- "$stack_pr" --json
```

Include every known review clone with repeated `--checkout /path/to/clone` arguments. Separate clones are not discovered automatically. The helper requires authenticated `gh` and follows base/head branches through open, closed, and merged PRs.

**Complete when:** the report identifies the ordered PRs, their base/head SHAs, and every supplied checkout. Report a missing parent as the boundary of the discovered stack.

## 2. Triage each PR

Work from the bottom PR upward. For each PR, inspect:

- Missing base commits and GitHub content mergeability.
- Hosted check results and GitHub's merge state.
- Local validation for the exact head SHA, alongside checkout dirtiness.
- Every unresolved review thread, including outdated threads and the latest reply. Follow the thread link when the first and latest comments leave context missing.

An unresolved thread marked `<!-- stack-review:decision -->` in its first comment is an explicit decision. Classify it as awaiting an answer or awaiting implementation. An answered decision stays open until its implementation is verified. Inspect unmarked threads too; ordinary PR comments are outside the helper's report.

Keep unknown and missing evidence visible. A local pass does not establish hosted check success, and content mergeability does not establish merge readiness. For `code-review`, return the captured SHAs and outstanding decisions as review inputs.

**Complete when:** every PR has an evidence-based status and every outstanding decision has a source link and next action.

## 3. Validate when required

When the requested work requires fresh local validation, follow [Local validation](validation.md). A status-only request proceeds to the report using the available evidence.

**Complete when:** required validation has a result attributable to the reviewed code, or its failure is recorded explicitly.

## 4. Report

Give one row per PR in dependency order with its head SHA, missing base commits, local validation, hosted checks, and outstanding decisions. Include PR and thread links, checkout cleanliness, and any incomplete discovery or unknown status.

**Complete when:** the report accounts for every discovered PR and supplied checkout.
