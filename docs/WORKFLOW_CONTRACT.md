# Repository Workflow Contract

Symphony is the orchestration layer. It decides which Linear ticket to run,
creates a workspace, launches Codex, records logs, and handles the handoff.

The target repository still needs its own workflow contract. That contract is
where you teach agents the repo's tribal knowledge:

- how to sync branches
- how to create and submit PRs
- which checks must pass
- how to read review comments
- where env vars and secrets live
- which sibling repos matter
- which deploy paths need human confirmation
- what "done" means for that repo

This separation is the useful pattern:

```text
Linear ticket
  -> Codex Symphony
  -> WORKFLOW.md prompt
  -> target repo AGENTS.md / agent.workflow.json / scripts
  -> PR ready for human merge
```

Symphony creates a persistent `## Codex Workpad` comment on each Linear issue
when `tracker.workpad.enabled` is true. The orchestrator keeps basic status
fresh there. If your agent has Linear tools, teach it to update the same comment
with plan, validation, review feedback, and handoff notes.

## Minimum Contract

At minimum, add an `AGENTS.md` file to the target repo:

```md
# Agent Instructions

Start here:

- Read this file before editing.
- Run `npm test` before handing off.
- Use GitHub CLI to open PRs.
- Stop before merge.

Workflow:

1. Sync with `git pull --ff-only origin main`.
2. Create a branch named `symphony-<ticket-id>`.
3. Make the smallest scoped change.
4. Run focused tests, then the default check.
5. Open a ready-for-review PR.
6. Watch CI and read review comments.
7. Fix actionable comments.
8. Hand off with PR URL, checks, tests, and risk.
```

Then make the prompt in `WORKFLOW.md` tell Codex to read it:

```md
Use the repository workflow contract:

- Start by reading `AGENTS.md`.
- Follow the repo's branch, PR, CI, and review instructions exactly.
- Self-review your own diff before handoff. Include `Self Review` with
  alternatives/tradeoffs considered and `Performance Evidence` with measured
  numbers, added query fan-out or network/database calls, or a clear explanation
  for why no benchmark was needed.
- Stop before merge.
```

## Rich Contract

For a larger repo, use both:

- `AGENTS.md`: human-readable map and operating rules.
- `agent.workflow.json`: machine-readable commands and policies.
- `scripts/agent-workflow.js`: command that prints/checks those rules.

This mirrors the workflow-agent layer that inspired Symphony.

Example `agent.workflow.json`:

```json
{
  "version": 1,
  "baseBranch": "main",
  "syncCommand": "git pull --ff-only origin main",
  "pr": {
    "createCommand": "gh pr create --fill",
    "readyCommand": "gh pr ready",
    "stopBeforeMerge": true
  },
  "checks": {
    "default": "npm test",
    "changedFiles": "npm test -- --runInBand"
  },
  "review": {
    "watchCiCommand": "gh pr checks --watch",
    "readCommentsCommand": "gh pr view --json comments,reviews",
    "mustReadCommentsWhenCiGreen": true
  },
  "handoff": [
    "PR URL",
    "CI status",
    "review comments addressed",
    "local verification",
    "residual risk"
  ],
  "auxiliaryRepositories": []
}
```

Example `scripts/agent-workflow.js`:

```js
#!/usr/bin/env node
"use strict";

const fs = require("node:fs");

const workflow = JSON.parse(fs.readFileSync("agent.workflow.json", "utf8"));
const command = process.argv[2] || "instructions";

if (command === "validate") {
  if (!workflow.baseBranch) throw new Error("baseBranch is required");
  if (!workflow.checks?.default) throw new Error("checks.default is required");
  console.log("Agent workflow validation passed.");
  process.exit(0);
}

if (command === "instructions") {
  console.log(`Sync before work: ${workflow.syncCommand}`);
  console.log(`Run default checks: ${workflow.checks.default}`);
  console.log(`Create PR: ${workflow.pr.createCommand}`);
  console.log("Stop before merge.");
  process.exit(0);
}

console.error("Usage: node scripts/agent-workflow.js <validate|instructions>");
process.exit(1);
```

Then update `AGENTS.md`:

```md
# Agent Instructions

Before opening or updating a PR, run:

- `node scripts/agent-workflow.js validate`
- `node scripts/agent-workflow.js instructions`

Follow the printed instructions exactly. Stop before merge.
```

## Graphite Example

If your repo uses Graphite, encode that in the contract:

```md
Workflow:

- Run `gt sync` before feature work.
- If Graphite says the branch is untracked, run `gt track --parent main --no-interactive`.
- Use `gt create --ai` for new PRs.
- If AI metadata fails because the diff is too large, use `gt create -m "<concise title>"`.
- Use `gt submit --ai --publish` for new PRs.
- Use `gt submit --no-edit` when updating an existing PR.
- Stop before merge.
```

## Review Automation Example

If your repo has AI review comments, teach the agent how to consume them:

```md
Review:

- Do not treat green CI as proof that review comments are absent.
- Wait for review automation to finish.
- Read PR comments and reviews.
- On rework runs, inspect GitHub feedback added after the latest branch update;
  Symphony injects it into `{{ issue.recent_github_comments }}` when an existing
  workspace PR is available.
- Prefer any consolidated "fix all" comment when your reviewer provides one.
- Ignore comments already addressed by your latest patch.
- Rerun focused tests after fixing comments.
```

## Cross-Repo Work

For features that span repos, put the map in the target repo contract:

```json
{
  "auxiliaryRepositories": [
    {
      "name": "web-app",
      "path": "../web-app",
      "owns": "frontend UI and routing",
      "prFlow": "same as primary repo"
    },
    {
      "name": "infrastructure",
      "path": "../infrastructure",
      "owns": "deploy manifests and service config",
      "deployRequiresHumanConfirmation": true
    }
  ]
}
```

Then include in `AGENTS.md`:

```md
For cross-repo features, inspect the sibling repos listed in
`agent.workflow.json`. Create auxiliary PRs with the same branch and PR flow.
Do not deploy production infrastructure without explicit human confirmation.
```

## Why This Is Separate From Symphony

Keeping workflow knowledge in the target repo makes Symphony reusable. Each repo
can teach agents its own rules without changing the orchestration engine.
