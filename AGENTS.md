# Codex Symphony Agent Notes

This repository is a standalone orchestration harness. Keep changes generic:

- Do not bake in one company's Linear project, branch names, states, or repo paths.
- Keep `scripts/symphony.js` dependency-free where possible.
- Use Node's built-in test runner for local tests.
- Validate with `npm test` and `node -c scripts/symphony.js`.
