# Codex App Server

Codex Symphony uses `codex exec --json` by default. That is enough for the
common loop: Linear ticket in, isolated Codex run, PR ready for human merge.

Codex also ships an experimental app-server:

```bash
codex app-server --listen ws://127.0.0.1:0
```

You do not need app-server unless you want tighter protocol control than a
subprocess can provide.

## When `codex exec --json` Is Enough

- One prompt per agent turn.
- JSONL event streaming.
- Simple process supervision.
- Easy local logs.
- No custom tool injection.

## When App Server Is Worth It

- Long-lived interactive sessions.
- Custom tool injection into the Codex session.
- Richer bidirectional protocol events.
- A dashboard that can steer a live agent, not just observe it.
- Multiple clients attached to the same agent runtime.

## Current Recommendation

Keep `codex exec --json` as the default transport. Treat app-server support as an
optional advanced transport because the CLI marks it experimental and its
protocol may change.

The standalone harness is structured so the child command is configurable:

```yaml
codex:
  command: bash "$SYMPHONY_HOME/scripts/symphony-codex-run.sh"
```

That means an app-server runner can be added without changing Linear polling,
workspace management, state snapshots, or the dashboard.
