#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { LinearTracker } = require("./symphony.js");

const required = ["LINEAR_API_KEY", "LINEAR_E2E_TEAM_ID", "LINEAR_E2E_PROJECT_ID", "LINEAR_E2E_PROJECT_SLUG", "LINEAR_E2E_TARGET_REPO_ROOT"];
const missing = required.filter((name) => !process.env[name]);
if (missing.length > 0) {
	console.error(`Missing required env vars: ${missing.join(", ")}`);
	process.exit(2);
}

const runCodex = process.env.LINEAR_E2E_RUN_CODEX === "true";
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "codex-symphony-e2e-"));
const title = `Codex Symphony E2E ${new Date().toISOString()}`;
const description = "Created by codex-symphony live E2E. Safe to close/delete.";

async function graphql(query, variables) {
	const tracker = new LinearTracker({
		tracker: {
			endpoint: process.env.LINEAR_ENDPOINT || "https://api.linear.app/graphql",
			api_key: process.env.LINEAR_API_KEY,
			timeout_ms: 30000
		}
	});
	return tracker.postGraphql(query, variables);
}

async function createIssue() {
	const data = await graphql(
		`mutation SymphonyE2EIssueCreate($input: IssueCreateInput!) {
			issueCreate(input: $input) {
				success
				issue { id identifier title state { name } }
			}
		}`,
		{
			input: {
				teamId: process.env.LINEAR_E2E_TEAM_ID,
				projectId: process.env.LINEAR_E2E_PROJECT_ID,
				title,
				description
			}
		}
	);
	if (!data?.issueCreate?.success) {
		throw new Error("Linear issueCreate failed");
	}
	return data.issueCreate.issue;
}

function writeWorkflow(issue) {
	const workflowPath = path.join(tempRoot, "WORKFLOW.md");
	const command = runCodex ? `bash "${path.resolve(__dirname, "symphony-codex-run.sh")}"` : "symphony dry-run";
	fs.writeFileSync(
		workflowPath,
		`---
tracker:
  kind: linear
  endpoint: ${process.env.LINEAR_ENDPOINT || "https://api.linear.app/graphql"}
  api_key: $LINEAR_API_KEY
  project_slug: ${process.env.LINEAR_E2E_PROJECT_SLUG}
  active_states: ["${issue.state.name}"]
  terminal_states: ["Done", "Closed", "Canceled", "Cancelled"]
  workpad:
    enabled: true
repository:
  root: ${process.env.LINEAR_E2E_TARGET_REPO_ROOT}
  base_branch: ${process.env.LINEAR_E2E_BASE_BRANCH || "main"}
workspace:
  root: ${path.join(tempRoot, "workspaces")}
codex:
  command: ${command}
---

Handle {{ issue.identifier }}: {{ issue.title }}

This is a live E2E smoke test. Do not make product changes.
`
	);
	return workflowPath;
}

(async () => {
	const issue = await createIssue();
	const workflowPath = writeWorkflow(issue);
	childProcess.execFileSync(process.execPath, [path.resolve(__dirname, "symphony.js"), "once", "--workflow", workflowPath], {
		stdio: "inherit",
		env: { ...process.env, LINEAR_API_KEY: process.env.LINEAR_API_KEY }
	});
	console.log(`Created and dispatched ${issue.identifier}. Temp files: ${tempRoot}`);
})().catch((error) => {
	console.error(error.stack || error.message);
	process.exit(1);
});
