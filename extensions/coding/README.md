# Coding

Shared repository-change process graph, action forms, prompts, state, and deterministic Git finalization used by Local Repo Change and Remote Repo Change.

Owning extensions provide process identity, launcher policy, finalization copy, and optional repository credential requirements while retaining their persisted process and turn ids.

An owning extension may omit the shared launcher and supply a publication fragment. The fragment starts after `generate_commit_message` and owns the remaining publication turns and happy path.

After final implementation approval, `generate_commit_message` consumes the durable accepted `plan` without repository tools. It uses the model configured for `pi.process_title_generation.model_profile` (or the process's inherited model when title generation has no profile), applies the formatting rules pinned in project metadata at launch, and persists the normalized plain-text message in finalization state. Retries and merge-conflict recovery reuse that message.

Deterministic finalization passes the message directly to Git, disables hooks and signing, and uses the repository/global `user.name` and `user.email`. It fails before staging or a commit-producing merge when Git identity is unavailable; Leitwerk never supplies an author identity. Its Chronicle progress report distinguishes checkout validation, base fetch, commit/integration, and publication. Runtime failures mark the active step failed; merge-conflict outcomes identify the integration step.

`commitAndPushWorkBranch()` commits dirty workspace files and pushes only the checked-out feature branch. It rejects missing Git identity, unresolved conflicts, branch mismatches, and remote heads that do not match the committed HEAD.
