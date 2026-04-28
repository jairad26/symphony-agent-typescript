"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	LinearTracker,
	WorkspaceManager,
	estimateTokenUsageFromText,
	extractTokenUsage,
	classifyLifecycleState,
	loadConfig,
	loadLocalEnv,
	normalizeIssue,
	parseCodexJsonEvent,
	parseEnvFile,
	renderDashboard,
	renderWorkpadComment,
	renderPrompt,
	validateDispatchConfig
} = require("../scripts/symphony.js");

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "codex-symphony-test-"));
}

function writeWorkflow(dir, frontMatter, prompt = "Issue {{ issue.identifier }}: {{ issue.title }}") {
	const file = path.join(dir, "WORKFLOW.md");
	fs.writeFileSync(file, `---\n${frontMatter.trim()}\n---\n\n${prompt}\n`);
	return file;
}

test("loads workflow config, resolves secrets, and validates", () => {
	const dir = tempDir();
	try {
		const workflowPath = writeWorkflow(
			dir,
			`
tracker:
  kind: linear
  api_key: $LINEAR_API_KEY
  project_slug: orbit
repository:
  root: $TARGET_REPO_ROOT
workspace:
  root: tmp/symphony
codex:
  command: symphony dry-run
`
		);

		const config = loadConfig({
			workflowPath,
			env: {
				LINEAR_API_KEY: "linear-token",
				TARGET_REPO_ROOT: dir
			}
		});

		assert.equal(config.tracker.api_key, "linear-token");
		assert.equal(config.repository.root, dir);
		assert.match(config.workspace.root, /tmp\/symphony$/);
		assert.deepEqual(validateDispatchConfig(config), []);
		assert.match(validateDispatchConfig(loadConfig({ workflowPath, env: { TARGET_REPO_ROOT: dir } }), { requireSecrets: true }).join("\n"), /tracker\.api_key/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("loads env files without mangling quoted inline comments", () => {
	const dir = tempDir();
	try {
		const envPath = path.join(dir, ".env.local");
		fs.writeFileSync(envPath, "LINEAR_API_KEY=local-token\nexport OTHER_KEY='quoted value'\nINLINE_COMMENT=value # comment\nQUOTED_COMMENT=\"postgres://host/db # primary\"\n");

		assert.deepEqual(parseEnvFile(fs.readFileSync(envPath, "utf8")), {
			INLINE_COMMENT: "value",
			LINEAR_API_KEY: "local-token",
			OTHER_KEY: "quoted value",
			QUOTED_COMMENT: "postgres://host/db # primary"
		});
		assert.equal(loadLocalEnv({ env: { LINEAR_API_KEY: "process-token" }, envPath }).LINEAR_API_KEY, "process-token");
		assert.equal(loadLocalEnv({ env: {}, envPath }).LINEAR_API_KEY, "local-token");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("renders prompt variables strictly", () => {
	const issue = normalizeIssue({ id: "1", identifier: "TASK-1", title: "Wire it", description: "Ticket body", state: { name: "Todo" }, priority: 1 });

	assert.equal(renderPrompt("Do {{ issue.identifier }}: {{ issue.title }}", { issue }), "Do TASK-1: Wire it");
	assert.equal(renderPrompt("Body: {{ issue.description }}", { issue }), "Body: Ticket body");
	assert.throws(() => renderPrompt("{{ issue.missing }}", { issue }), /unknown prompt variable/);
	assert.throws(() => renderPrompt("{{ issue.title | upcase }}", { issue }), /unsupported prompt filter/);
});

test("keeps workspaces inside the workspace root", () => {
	const dir = tempDir();
	try {
		const manager = new WorkspaceManager({ workspace: { root: dir }, hooks: { timeout_ms: 1000 } }, () => {});
		const workspace = manager.prepare(normalizeIssue({ id: "1", identifier: "../TASK 1?", title: "Bad chars", state: { name: "Todo" } }));

		assert.ok(workspace.path.startsWith(dir));
		assert.equal(path.basename(workspace.path), ".._TASK_1_");
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("Linear state updates use issueUpdate with stateId", async () => {
	const requests = [];
	const tracker = new LinearTracker(
		{
			tracker: {
				endpoint: "https://api.linear.app/graphql",
				api_key: "token",
				timeout_ms: 1000
			}
		},
		async (_url, request) => {
			const body = JSON.parse(request.body);
			requests.push(body);
			return {
				ok: true,
				async json() {
					return {
						data: {
							issueUpdate: {
								success: true,
								issue: { id: "issue-1", identifier: "TASK-1", title: "Moved", state: { name: "In Progress" } }
							}
						}
					};
				}
			};
		}
	);

	const updated = await tracker.updateIssueState("issue-1", "state-in-progress");

	assert.equal(updated.state, "In Progress");
	assert.match(requests[0].query, /issueUpdate/);
	assert.deepEqual(requests[0].variables, { id: "issue-1", input: { stateId: "state-in-progress" } });
});

test("Linear workpad comments are created or reused by marker", async () => {
	const requests = [];
	let existingComments = [];
	const tracker = new LinearTracker(
		{
			tracker: {
				endpoint: "https://api.linear.app/graphql",
				api_key: "token",
				timeout_ms: 1000
			}
		},
		async (_url, request) => {
			const body = JSON.parse(request.body);
			requests.push(body);
			if (body.query.includes("SymphonyIssueComments")) {
				return {
					ok: true,
					async json() {
						return { data: { issue: { comments: { nodes: existingComments } } } };
					}
				};
			}
			if (body.query.includes("SymphonyCommentCreate")) {
				existingComments = [{ id: "comment-1", body: body.variables.input.body }];
				return {
					ok: true,
					async json() {
						return { data: { commentCreate: { success: true, comment: existingComments[0] } } };
					}
				};
			}
			return {
				ok: true,
				async json() {
					return { data: { commentUpdate: { success: true, comment: { id: body.variables.id, body: body.variables.input.body } } } };
				}
			};
		}
	);

	const created = await tracker.ensureWorkpadComment("issue-1", "<!-- marker -->", "<!-- marker -->\n## Codex Workpad");
	const updated = await tracker.ensureWorkpadComment("issue-1", "<!-- marker -->", "<!-- marker -->\nupdated");

	assert.equal(created.id, "comment-1");
	assert.equal(updated.id, "comment-1");
	assert.match(requests[1].query, /commentCreate/);
	assert.match(requests[3].query, /commentUpdate/);
});

test("renders a durable workpad comment body", () => {
	const body = renderWorkpadComment({
		marker: "<!-- marker -->",
		issue: normalizeIssue({ id: "1", identifier: "TASK-1", title: "Wire it", state: "In Progress" }),
		entry: {
			attempt: null,
			workspace: { path: "/tmp/workspace/TASK-1" },
			session_id: "session-1",
			last_event: "agent_output",
			tokens: { input_tokens: 3, output_tokens: 2, total_tokens: 5 }
		},
		status: "Launching agent",
		note: "hello",
		generatedAt: "2026-01-01T00:00:00.000Z"
	});

	assert.match(body, /<!-- marker -->/);
	assert.match(body, /## Codex Workpad/);
	assert.match(body, /TASK-1 - Wire it/);
	assert.match(body, /Tokens observed: 5 total/);
});

test("classifies lifecycle states and renders the dashboard", () => {
	const config = {
		lifecycle: {
			todo_states: ["Todo"],
			in_progress_states: ["In Progress"],
			human_review_states: ["Human Review"],
			rework_states: ["Rework"],
			merging_states: ["Merging"],
			done_states: ["Done"]
		}
	};
	const snapshot = {
		generated_at: "2026-01-01T00:00:00.000Z",
		counts: { running: 1, retrying: 0 },
		running: [
			{
				issue_identifier: "TASK-1",
				state: "In Progress",
				lifecycle: "in_progress",
				last_event: "agent_output",
				tokens: { total_tokens: 42 },
				workspace: { path: "/tmp/workspace" }
			}
		],
		retrying: [],
		codex_totals: { total_tokens: 42, seconds_running: 7 }
	};

	assert.equal(classifyLifecycleState(config, "Human Review"), "human_review");
	assert.equal(classifyLifecycleState(config, null, "retrying"), "rework");
	assert.match(renderDashboard(snapshot), /Codex Symphony/);
	assert.match(renderDashboard(snapshot), /TASK-1/);
});

test("parses Codex token events and estimates running output activity", () => {
	const tokenEvent = parseCodexJsonEvent(
		JSON.stringify({
			timestamp: "2026-01-01T00:00:00.000Z",
			type: "event_msg",
			payload: {
				type: "token_count",
				info: { total_token_usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 } },
				rate_limits: { limit_id: "codex" }
			}
		}),
		{ sessionId: "TASK-1-session", streamName: "stdout" }
	);
	const itemEvent = parseCodexJsonEvent(JSON.stringify({ type: "item.completed", item: { aggregated_output: "abcd".repeat(10) } }), {
		sessionId: "TASK-1-session",
		streamName: "stdout"
	});

	assert.deepEqual(extractTokenUsage({ total_token_usage: { input_tokens: 8, output_tokens: 6, total_tokens: 14 } }), { input_tokens: 8, output_tokens: 6, total_tokens: 14 });
	assert.deepEqual(tokenEvent.usage, { input_tokens: 8, output_tokens: 6, total_tokens: 14 });
	assert.deepEqual(estimateTokenUsageFromText("abcd".repeat(10)), { input_tokens: 10, output_tokens: 0, total_tokens: 10 });
	assert.deepEqual(itemEvent.usage_delta, { input_tokens: 10, output_tokens: 0, total_tokens: 10 });
});
