> The bundled workflow and repository workflow contracts have been retired.
> Supply an explicit workflow configuration to use the engine; repository guidance lives in `AGENTS.md`.

# Symphony Agent TypeScript

Symphony Agent TypeScript is a small, standalone TypeScript/Node.js implementation of the Symphony pattern: turning Linear tickets into coding-agent runs against a real git repository. Codex is the default adapter, but the runner can also supervise OpenCode, Claude Code, Cursor CLI, or any generic CLI agent command.

It does the boring orchestration work:

- Polls Linear for candidate issues.
- Creates isolated per-ticket workspaces.
- Runs a configured agent adapter command with a rendered issue prompt.
- Streams child-agent output into `agent-run.log`.
- Tracks running/retry state through a local JSON API.
- Serves a local dashboard for running, retrying, lifecycle, and token activity.
- Optionally moves Linear tickets to `In Progress` and `In Review`.
- Maintains one persistent `## Symphony Workpad` Linear comment per issue.
- Creates/reuses git worktrees and records PR handoff evidence.

## Requirements

- Node.js 20+
- A Linear API key
- A CLI coding agent on your `PATH` (`codex` by default, or another configured adapter)
- Git and GitHub CLI for PR handoff
- Optional: Graphite CLI if your repo uses Graphite

## Quick Start

### Option 1. Ask An Agent To Set It Up

Give your coding agent this prompt:

> Set up Symphony Agent TypeScript for my repository based on https://github.com/jairad26/symphony-agent-typescript. Configure Linear, the target repo, safe concurrency, and the repo workflow prompt; start in dry-run or one-ticket mode, then run the validation checks.

### Option 2. Manual Setup

```bash
git clone https://github.com/jairad26/symphony-agent-typescript.git && cd symphony-agent-typescript
cp .env.example .env.local && $EDITOR .env.local /path/to/workflow.md
```

```bash
npm run validate -- --workflow /path/to/workflow.md --require-secrets
npm run serve -- --workflow /path/to/workflow.md
```

Edit `.env.local`:

```bash
LINEAR_API_KEY=lin_api_...
TARGET_REPO_ROOT=~/github.com/acme/my-service
```

Create your workflow configuration outside this repository:

- `tracker.project_slug`: Linear project slug id.
- `tracker.assignee_email`: owner filter for tickets the harness may pick up.
- `tracker.active_states`: states to poll.
- `tracker.state_transitions`: optional Linear state ids for dispatch and PR handoff.
- `tracker.workpad`: enable or customize the persistent Linear workpad comment.
- `repository.root`: target git repository.
- `repository.base_branch`: usually `main` or `develop`.
- `workspace.root`: where per-ticket workspaces live.
- `agent_runtime.provider`: `codex`, `opencode`, `claude-code`, `cursor-cli`, or `generic-cli`.
- `agent_runtime.command`: command Symphony runs for each ticket.
- `agent_runtime.event_format`: `codex-json` for Codex JSONL, or `plain` for generic stdout/stderr tracking.
- Prompt body: the actual instructions the child agent receives.

Validate:

```bash
npm run validate -- --workflow /path/to/workflow.md --require-secrets
```

Set the Linear project and target repository in that explicit configuration
before validation.

Run one poll:

```bash
npm run once -- --workflow /path/to/workflow.md
```

Run continuously:

```bash
npm run serve -- --workflow /path/to/workflow.md
```

The server prints a local URL. Visit:

- `/` for the dashboard.
- `/api/v1/state` for all running/retry state.
- `/api/v1/<issue_identifier>` for one ticket.
- `/api/v1/refresh` with `POST` to trigger a poll.

## How This Relates To Harness Engineering

Harness engineering is the repo-level foundation. It makes a codebase legible,
safe, and repeatable for coding agents before any orchestrator starts handing it
real work. A harnessed repo should teach agents how to operate through files
like:

- `AGENTS.md` for human-readable rules and local context.
- `yarn agent:*`, `npm run agent:*`, or equivalent checks that agents can run.
- Focused diagnostics docs/scripts for production logs, traces, databases,
  search systems, deploys, and cross-repo workflows.

Symphony is the orchestration layer above that foundation. It does not replace
the target repo's harness; it relies on it. Symphony decides which Linear ticket
to run, creates an isolated workspace, renders the ticket plus recent Linear
comments and recent GitHub PR feedback into a prompt, starts the child agent, tracks
logs/tokens/status when the adapter exposes token events, updates the Linear workpad, and leaves the PR ready for
human review or merge according to the repo's own workflow contract.

The useful mental model is:

```text
Harness Engineering = teach one repo how agents should work safely.
Symphony = route Linear work into those harnessed repos and supervise the runs.
```

This repository is the TypeScript Symphony runner. The target repositories still
need their own harness files so the child agent knows how to build, test,
open PRs, handle review comments, and stop at the right handoff point.

## How It Works

`scripts/symphony.js` is the orchestrator:

- Reads `WORKFLOW.md` front matter and prompt text.
- Loads `.env.local` without overriding existing environment variables.
- Queries Linear for active issues.
- Applies assignment, state, blocker, concurrency, and retry rules.
- Pulls recent Linear comments into the prompt, preferring comments added after
  the last Symphony workpad update.
- Pulls recent GitHub PR comments/reviews from an existing workspace PR,
  preferring feedback added after the branch's latest update.
- Creates or updates the issue's persistent `## Symphony Workpad` comment.
- Creates a per-issue workspace under `workspace.root`.
- Renders the prompt with `{{ issue.* }}` variables.
- Runs the configured child command through an adapter and records output.

`agent_runtime` selects the child runtime:

```yaml
agent_runtime:
  provider: codex
  command: bash "$SYMPHONY_HOME/scripts/symphony-codex-run.sh"
  event_format: codex-json
```

Supported providers are:

- `codex`: parses `codex exec --json` token/output events.
- `opencode`: runs OpenCode CLI through `scripts/symphony-opencode-run.sh`.
- `claude-code`: runs Claude Code headless through `scripts/symphony-claude-run.sh`.
- `cursor-cli`: runs Cursor Agent CLI via `cursor-agent` and tracks plain stdout/stderr.
- `generic-cli`: runs any command that reads `SYMPHONY_PROMPT_FILE` or otherwise uses the environment Symphony provides.

`scripts/symphony-codex-run.sh` is the default Codex child command:

- Creates or reuses a git worktree for the target repo.
- Links `node_modules` and the configured env file when present.
- Runs `gt sync` when Graphite is installed.
- Runs `codex exec --json`.
- Marks an existing PR ready and optionally moves Linear to `In Review`.

## Target Repo Workflow Contract

Symphony is generic on purpose. Put repo-specific tribal knowledge in the target
repo, then tell the Symphony prompt to read it.

Recommended target repo files:

- `AGENTS.md`: human-readable agent rules.
- Review-bot retrigger rules: when to ask automation for a fresh review after
  addressing comments, including a maximum retrigger count per PR.
- Self-review/performance rules: what the agent must inspect in its own diff
  before handoff, including alternatives considered, measured numbers, and
  added query fan-out or network/database calls.

See `templates/AGENTS.md` for repository guidance.
See `docs/AGENT_ADAPTERS.md` for non-Codex adapter examples. See
`docs/CODEX_APP_SERVER.md` for why `codex exec --json` is the default Codex
transport and when app-server is worth adding.

## Ticket Template

Use a ticket shape like this for best results:

```md
Goal:
What should be true after this is done?

Scope:
Repo/service/files/product area expected to change.

Context:
Links, examples, failing query, ids, logs, screenshots, current behavior.

Env vars / secrets:
Where the agent should pull required env vars/secrets from. Do not paste secrets.

Acceptance criteria:
Concrete checklist for done.

Verification:
Commands to run, dev/prod checks, or manual QA.

Constraints:
What not to change, rollout notes, risk areas.
```

## Restart Behavior

You can stop and restart Symphony. It re-reads Linear, reuses existing workspaces, cleans terminal-ticket workspaces, and retries active work according to the current config.

Running child agent processes do not survive shutdown. A restart means reconcile and relaunch as needed, not resume the exact same OS process.

## Safety Defaults

- Filter by project and assignee before dispatch.
- Limit concurrency with `agent.max_concurrent_agents`.
- Keep PR handoff explicit.
- Treat Linear state transitions as best effort.

## Development

```bash
npm test
```

The test suite uses Node's built-in test runner and does not require external services.

Optional live Linear E2E:

```bash
LINEAR_API_KEY=... \
LINEAR_E2E_TEAM_ID=... \
LINEAR_E2E_PROJECT_ID=... \
LINEAR_E2E_PROJECT_SLUG=... \
LINEAR_E2E_TARGET_REPO_ROOT=~/github.com/acme/my-service \
npm run test:e2e:linear
```

Set `LINEAR_E2E_RUN_CODEX=true` to run a real Codex child process instead of a
dry-run dispatch.
