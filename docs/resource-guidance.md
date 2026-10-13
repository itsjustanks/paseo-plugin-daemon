# Resource-aware agents

Hosts adds a short instruction block to each new non-internal agent through Paseo's
`agent.create` hook. It appends to `config.systemPrompt`; existing instructions, provider,
tools, permissions and environment stay intact. The hook performs no resource scan or I/O.

The guidance asks agents to reuse suitable dev servers and shared browser sessions, check
headroom before heavy work, run heavy validation sequentially by default, use documented
worker limits and avoid unbounded filesystem scans. Agents must verify ownership before
cleaning up their temporary jobs and ask before stopping somebody else's work. Idle,
sleeping or archived does not establish that a process is safe to stop.

This is prompt guidance, not a CPU/memory limit, scheduler or automatic cleanup policy.
The heavy-job warning, optional memory guard and Housekeeping controls remain independent.

It takes effect for agents created after the updated plugin is active. Existing chats are
not rewritten or restarted. Paseo saves the resulting agent configuration, so an agent
created with the guidance retains it on resume; disabling the plugin does not remove
instructions already saved in that agent. Internal title/commit helpers are excluded.

The supported session-open hook only edits environment variables. It cannot retrofit a
system prompt into a running or resumed chat. See the official
[before-hook contract](https://paseo.sh/docs/plugins/reference.md#before-hooks).
