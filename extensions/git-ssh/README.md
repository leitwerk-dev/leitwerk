# Git SSH

Provides pinned, non-interactive Git-over-SSH credential profiles to repository processes. Configure profiles under `extensions.git-ssh.credentials`. Private keys and `known_hosts` are delivered only in authenticated `worker.start` IPC; ambient SSH configuration and agents are not used.
