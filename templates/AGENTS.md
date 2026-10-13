# Agent Instructions

This file contains guidance for coding agents contributing to the repository.

## Start Here

- Read this file before editing.
- Read the closest docs for the area you are changing.
- Keep changes scoped to the ticket.

## Workflow

1. Sync before feature work.
2. Create or reuse a branch for the ticket.
3. Make the smallest coherent change.
4. Run focused tests for the touched area.
5. Run the default repo check.
6. Open a ready-for-review PR.
7. Wait for CI and review automation.
8. Read review comments even if CI is green.
9. Fix actionable comments.

## Commands

- Default check: `npm test`

## Handoff

Include:

- PR URL
- CI status
- review comments addressed
- local checks run
- residual risk

## PR Review Loop

1. Self-review the diff for correctness, security, test coverage, and performance;
   run the relevant local checks before submitting.
2. Read the live PR head, CI results/failure logs, reviewer summaries, and inline
   threads. A green review check alone does not prove there are no comments.
3. Fix valid findings within the task's scope; explain findings that are invalid
   or already addressed. Preserve unrelated work.
4. Rerun relevant checks, commit and push fixes, then obtain a fresh review of the
   latest commit from the configured reviewer. Let automatic reviews start;
   request another review only when needed, never while one is already running
   (`@coderabbitai review` for CodeRabbit or `@greptileai` for Greptile).
5. Repeat review, repair, validation, and fresh review until relevant required
   checks pass and the latest substantive review has no actionable unresolved
   findings. Do not stop merely because a fixed number of rounds has elapsed.
6. If CI/review is pending or externally blocked, continue independent fixes and
   use a native Codex heartbeat for later rechecks when available. Rate limits,
   missing reviews, and summary-only bot responses are not review clearance.
   Report the latest commit, checks, feedback addressed/outstanding, and the
   exact remaining blocker; never claim an unfinished review loop is complete.
