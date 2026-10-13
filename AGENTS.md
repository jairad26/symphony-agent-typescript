# Codex Symphony Agent Notes

This repository is a standalone orchestration harness. Keep changes generic:

- Do not bake in one company's Linear project, branch names, states, or repo paths.
- Keep `scripts/symphony.js` dependency-free where possible.
- Use Node's built-in test runner for local tests.
- Validate with `npm test` and `node -c scripts/symphony.js`.

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
