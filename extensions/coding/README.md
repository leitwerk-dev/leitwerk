# Coding

Shared repository-change planning, review, implementation, state, commit-message, and feature-branch publication support used by provider-owned processes and development compositions.

Owning extensions provide process identity, launcher policy, finalization copy, repository credential requirements, and a publication fragment. `@leitwerk-dev/forgejo-repo-change`, `@leitwerk-dev/github-repo-change`, and `@leitwerk-dev/gitlab-repo-change` are production consumers; the public sandbox supplies a local-only publication fragment for scripted scenarios.

After final implementation approval, `generate_commit_message` consumes the durable accepted `plan` without repository tools. It uses the model configured for `pi.process_title_generation.model_profile` (or the process's inherited model when title generation has no profile), applies the formatting rules pinned in project metadata at launch, and persists the normalized plain-text message in finalization state. Publication fragments consume that message.

`commitAndPushWorkBranch()` requires an explicit trusted Git identity, commits dirty workspace files, and pushes only the checked-out feature branch. It rejects invalid Git identity, unresolved conflicts, branch mismatches, and remote heads that do not match the committed HEAD.

Turn labels use short task names: Plan, Review Plan, Implement, and Review. Automated assessments use Assess Plan and Assess Implementation so operators can distinguish them from their own decisions. Repository-change processes share these labels and turn ids.

## Shared publication

`createRepositoryChangePublication()` constructs the delivery, feedback, CI repair,
rebase, and operator recovery fragment used by Forgejo, GitHub, and GitLab repository
change processes. Its adapter supplies provider operations, native evidence sources,
repair tools/prompts, pinned identity resolution, and stored names. The shared module
owns Git publication and lifecycle policy without importing provider integrations.
Provider cursors and receipts remain durable in namespaced publication state.
Forgejo retains its original namespace, turn/action identifiers, and write identities.
