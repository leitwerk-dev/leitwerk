# Git SSH

Provides pinned, non-interactive Git-over-SSH credential profiles to repository processes. Configure profiles under `extensions.git-ssh.credentials`. Private keys and `known_hosts` are delivered only in authenticated `worker.start` IPC; ambient SSH configuration and agents are not used.

Dependent server extensions can use `gitSshIntegration.preflight()` before launch. The preflight verifies the repository's base ref with `git ls-remote`. When write access is required, it fetches that ref and performs a dry-run push to a unique probe branch. The check uses only the selected profile, does not create the probe branch, and never returns credential material.
