---
tracker:
  kind: linear
  endpoint: https://api.linear.app/graphql
  api_key: $LINEAR_API_KEY
  project_slug: your-linear-project-slug-id
  assignee_email: you@example.com
  active_states: ["Todo", "In Progress"]
  terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"]
  state_transitions:
    on_dispatch_state_id: ""
    on_pr_open_state_id: ""
  workpad:
    enabled: true
    marker: "<!-- symphony-agent-workpad -->"
polling:
  interval_ms: 30000
repository:
  root: $TARGET_REPO_ROOT
  base_branch: main
  branch_prefix: symphony
  env_file: .env.local
  link_node_modules: true
  sync_on_tick: true
workspace:
  root: ~/.symphony/workspaces/example
hooks:
  timeout_ms: 60000
agent:
  max_concurrent_agents: 3
  max_turns: 3
  max_retry_backoff_ms: 300000
  max_concurrent_agents_by_state:
    Todo: 3
lifecycle:
  todo_states: ["Todo"]
  in_progress_states: ["In Progress"]
  human_review_states: ["Human Review", "In Review"]
  rework_states: ["Rework"]
  merging_states: ["Merging"]
  done_states: ["Done", "Closed"]
agent_runtime:
  provider: codex
  command: bash "$SYMPHONY_HOME/scripts/symphony-codex-run.sh"
  event_format: codex-json
  approval_policy: never
  thread_sandbox: workspace-write
  turn_sandbox_policy: workspace-write
  turn_timeout_ms: 3600000
  read_timeout_ms: 5000
  stall_timeout_ms: 300000
---

You are an autonomous coding agent working in the target repository.

Issue: `{{ issue.identifier }}: {{ issue.title }}`
State: `{{ issue.state }}`
Priority: `{{ issue.priority }}`

Linear ticket body:

{{ issue.description }}

Recent Linear comments since the last Symphony workpad update:

{{ issue.recent_comments }}

Recent GitHub PR comments since the last branch update:

{{ issue.recent_github_comments }}

Use the repository workflow contract:

- Read the repository's agent instructions first, such as `AGENTS.md`, `CLAUDE.md`, or local docs.
- If the repo has `agent.workflow.json` or `scripts/agent-workflow.js`, use them as the source of truth for branch, PR, CI, review, and handoff rules.
- Use the existing `## Symphony Workpad` Linear comment as the persistent progress scratchpad when Linear tools are available.
- The scheduler runs a best-effort repository sync before each candidate poll so merged Graphite branches and stale worktree metadata are visible before blocker checks.
- Sync before feature work. If the repo uses Graphite, run `gt sync`.
- Linear blockers are hard gates. Symphony must not pick up an issue while any blocker is still in a non-terminal Linear state, even if the blocker branch or PR already exists.
- If `SYMPHONY_STACK_PARENT_BRANCH` is set, create this branch from that blocker branch so the PRs stack in Graphite.
- Create a dedicated branch for the issue. If Graphite says the branch is untracked, run `gt track --parent "$SYMPHONY_STACK_PARENT_BRANCH" --no-interactive` when `SYMPHONY_STACK_PARENT_BRANCH` is set; otherwise run `gt track --parent <base-branch> --no-interactive`.
- Open a ready-for-review PR. With Graphite, prefer `gt create --ai` and `gt submit --ai --publish`; if AI metadata fails because the diff is too large, use a concise manual title.
- Wait for CI/review automation to finish before deciding there are no comments. Read review comments even when CI is green.
- Address actionable review comments, rerun relevant local checks, and stop before merge.
- After pushing review-comment fixes, retrigger the configured review bot if the repo has one, then wait for the fresh review on the latest head before handoff. Do this at most 3 times per PR; if comments remain after that, stop and summarize the unresolved feedback.
- Before handoff, self-review your own diff for correctness, tests, and performance. Include `Self Review` with alternatives/tradeoffs considered and `Performance Evidence` with measured numbers, added query fan-out/network/database calls, or a clear explanation for why no benchmark was needed.
- Keep changes scoped to this Linear issue. If the ticket is missing essential context, make the smallest safe discovery pass and explain what is blocked.
- Include the PR URL, check status, local verification, and residual risk in your final response.
