# Future work

These capabilities are outside the supported MVP scope. Listing them is not a delivery commitment; promote a capability only with an explicit contract and implementation.

- **Per-process authorization and tenant isolation:** Current authentication and API tokens grant application-wide access with actor attribution.
- **General process-to-process creation:** The operator-initiated ticket draft flow is a constrained exception whose lifecycle does not cascade from its parent.
- **Configuration-defined workflows:** Process turns, graphs, transitions, and actions remain code-defined.
- **Arbitrary UI plugins:** Extensions may contribute bounded slot renderers and declared shell/shortcut hooks; they do not replace shell navigation.
- **Ambient or repository Pi resource import:** Automatic loading of repository `.pi` files or an operator's ambient `~/.pi/agent` directory; selectable installed skill packs are the supported mechanism.
- **macOS worker sandboxing:** Local workers run as the host OS user.
- **Multi-server coordination and external databases:** Storage uses a single server writing to SQLite.
- **Inbound local session handover:** Importing a local Pi session into Leitwerk for background execution (outbound export from Leitwerk to local Pi is supported).
- **Queueing future business actions:** Queuing unstarted business actions on an existing process.
- **Rate, request, and storage quotas:** Deferred until a concrete deployment requirement arises.
- **Dynamic model classification and routing:** Repository- or instance-derived classifications, dynamic requirements, provider failover, availability-based substitution, learned routing, and cost-budget enforcement. Scoped preferences do not relax static requirements.
- **Per-user UI preferences and arbitrary YAML editing:** Settings in `/settings` remain installation-shared overrides.
