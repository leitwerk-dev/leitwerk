# Remote Repo Change

Final approval generates and persists a commit message from the accepted plan before deterministic Git finalization. Repository-specific formatting is selected by the server's `commit_messages` locator mapping and pinned when the process launches. Git commits use the operator-configured repository/global identity; configure `user.name` and `user.email` before finalization.

Plans, implements, reviews, commits, integrates the latest remote base, and directly pushes a change to the configured base branch. Version 1 accepts only SSH repository locators and a `git-ssh` credential profile. Pushes are non-force; merge and pull requests are intentionally out of scope.
