# Codex Symphony

Codex Symphony is a small, standalone harness for turning Linear tickets into Codex coding-agent runs against a real git repository.

It does the boring orchestration work:

- Polls Linear for candidate issues.
- Creates isolated per-ticket workspaces.
- Runs `codex exec` with a rendered issue prompt.
- Streams child-agent output into `agent-run.log`.
- Tracks running/retry state through a local JSON API.
- Serves a local dashboard for running, retrying, lifecycle, and token activity.
- Optionally moves Linear tickets to `In Progress` and `In Review`.
- Maintains one persistent `## Codex Workpad` Linear comment per issue.
- Creates/reuses git worktrees and leaves PRs ready for human merge.

## Requirements

- Node.js 20+
- A Linear API key
- The Codex CLI on your `PATH`
- Git and GitHub CLI for PR handoff
- Optional: Graphite CLI if your repo uses Graphite

## Quick Start

```bash
git clone <this-repo>
cd codex-symphony
cp .env.example .env.local
```

Edit `.env.local`:

```bash
LINEAR_API_KEY=lin_api_...
TARGET_REPO_ROOT=~/github.com/acme/my-service
```

Edit `WORKFLOW.md`:

- `tracker.project_slug`: Linear project slug id.
- `tracker.assignee_email`: owner filter for tickets the harness may pick up.
- `tracker.active_states`: states to poll.
- `tracker.state_transitions`: optional Linear state ids for dispatch and PR handoff.
- `tracker.workpad`: enable or customize the persistent Linear workpad comment.
- `repository.root`: target git repository.
- `repository.base_branch`: usually `main` or `develop`.
- `workspace.root`: where per-ticket workspaces live.
- Prompt body: the actual instructions the child Codex agent receives.

Validate:

```bash
npm run validate -- --require-secrets
```

The example `WORKFLOW.md` intentionally fails validation until you replace the
placeholder Linear project and target repository values.

Run one poll:

```bash
npm run once
```

Run continuously:

```bash
npm run serve
```

The server prints a local URL. Visit:

- `/` for the dashboard.
- `/api/v1/state` for all running/retry state.
- `/api/v1/<issue_identifier>` for one ticket.
- `/api/v1/refresh` with `POST` to trigger a poll.

## How It Works

`scripts/symphony.js` is the orchestrator:

- Reads `WORKFLOW.md` front matter and prompt text.
- Loads `.env.local` without overriding existing environment variables.
- Queries Linear for active issues.
- Applies assignment, state, blocker, concurrency, and retry rules.
- Creates or updates the issue's persistent `## Codex Workpad` comment.
- Creates a per-issue workspace under `workspace.root`.
- Renders the prompt with `{{ issue.* }}` variables.
- Runs the configured child command and records output.

`scripts/symphony-codex-run.sh` is the default child command:

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
- `agent.workflow.json`: machine-readable branch, PR, CI, review, and handoff policy.
- `scripts/agent-workflow.js`: validates and prints the workflow contract.

See `docs/WORKFLOW_CONTRACT.md` and `templates/` for starter files.
See `docs/CODEX_APP_SERVER.md` for why `codex exec --json` is the default
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
Where Codex should pull required env vars/secrets from. Do not paste secrets.

Acceptance criteria:
Concrete checklist for done.

Verification:
Commands to run, dev/prod checks, or manual QA.

Constraints:
What not to change, rollout notes, risk areas.
```

## Restart Behavior

You can stop and restart Symphony. It re-reads Linear, reuses existing workspaces, cleans terminal-ticket workspaces, and retries active work according to the current config.

Running child `codex exec` processes do not survive shutdown. A restart means reconcile and relaunch as needed, not resume the exact same OS process.

## Safety Defaults

- Filter by project and assignee before dispatch.
- Limit concurrency with `agent.max_concurrent_agents`.
- Stop before merge.
- Keep PR handoff explicit.
- Treat Linear state transitions as best effort.

## Development

```bash
npm test
npm run validate
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
