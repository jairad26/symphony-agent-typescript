"use strict";

const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
	AgentRunner,
	LinearTracker,
	SymphonyOrchestrator,
	WorkspaceManager,
	createAgentAdapter,
	estimateTokenUsageFromText,
	extractTokenUsage,
	classifyLifecycleState,
	flattenGitHubFeedbackPayload,
	formatGitHubFeedback,
	loadConfig,
	loadLocalEnv,
	normalizeIssue,
	parseCodexJsonEvent,
	parseEnvFile,
	selectGitHubFeedbackSince,
	selectPromptComments,
	renderDashboard,
	renderWorkpadComment,
	renderPrompt,
	runRepositorySync,
	validateDispatchConfig
} = require("../scripts/symphony.js");

function tempDir() {
	return fs.mkdtempSync(path.join(os.tmpdir(), "symphony-agent-test-"));
}

function writeWorkflow(dir, frontMatter, prompt = "Issue {{ issue.identifier }}: {{ issue.title }}") {
	const file = path.join(dir, "WORKFLOW.md");
	fs.writeFileSync(file, `---\n${frontMatter.trim()}\n---\n\n${prompt}\n`);
	return file;
}

function initGitRepo(dir) {
	childProcess.execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
	childProcess.execFileSync("git", ["config", "user.email", "symphony@example.test"], { cwd: dir });
	childProcess.execFileSync("git", ["config", "user.name", "Symphony Test"], { cwd: dir });
	fs.writeFileSync(path.join(dir, "README.md"), "test\n");
	childProcess.execFileSync("git", ["add", "README.md"], { cwd: dir });
	childProcess.execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });
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
  assignee_email: $SYMPHONY_ASSIGNEE_EMAIL
  project_slug: orbit
repository:
  root: $TARGET_REPO_ROOT
workspace:
  root: tmp/symphony
agent_runtime:
  provider: codex
  command: symphony dry-run
  event_format: codex-json
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
		const configWithAssigneeDefault = loadConfig({
			workflowPath,
			env: {
				LINEAR_API_KEY: "linear-token",
				SYMPHONY_ASSIGNEE_EMAIL: "${SYMPHONY_ASSIGNEE_EMAIL:-jai@orbitsearch.com}",
				TARGET_REPO_ROOT: dir
			}
		});
		assert.equal(configWithAssigneeDefault.tracker.assignee_email, "jai@orbitsearch.com");
		assert.equal(config.agent_runtime.provider, "codex");
		assert.equal(config.agent_runtime.event_format, "codex-json");
		assert.equal(config.repository.root, dir);
		assert.match(config.workspace.root, /tmp\/symphony$/);
		assert.deepEqual(validateDispatchConfig(config), []);
		assert.match(validateDispatchConfig(loadConfig({ workflowPath, env: { TARGET_REPO_ROOT: dir } }), { requireSecrets: true }).join("\n"), /tracker\.api_key/);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("keeps legacy codex runtime config working", () => {
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
  command: legacy codex command
  stall_timeout_ms: 1234
`
		);
		const config = loadConfig({ workflowPath, env: { LINEAR_API_KEY: "linear-token", TARGET_REPO_ROOT: dir } });

		assert.equal(config.agent_runtime.provider, "codex");
		assert.equal(config.agent_runtime.command, "legacy codex command");
		assert.equal(config.agent_runtime.event_format, "codex-json");
		assert.equal(config.agent_runtime.stall_timeout_ms, 1234);
		assert.deepEqual(validateDispatchConfig(config), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("supports generic CLI-style agent adapters", () => {
	const adapter = createAgentAdapter({ provider: "claude-code", event_format: "plain" });

	assert.equal(adapter.provider, "claude-code");
	assert.equal(adapter.event_format, "plain");
	assert.equal(adapter.parseLine("plain output", { sessionId: "s1", streamName: "stdout" }), null);
});

test("plain adapters estimate output activity from stdout", () => {
	const events = [];
	const writes = [];
	const runner = new AgentRunner({ agent_runtime: { provider: "generic-cli", event_format: "plain" } });

	runner.handleChildOutputLine("abcd".repeat(4), {
		logStream: { write: (value) => writes.push(value) },
		sessionId: "s1",
		streamName: "stdout",
		onEvent: (event) => events.push(event)
	});

	assert.deepEqual(writes, [`${"abcd".repeat(4)}\n`]);
	assert.equal(events[0].event, "agent_output");
	assert.deepEqual(events[0].usage_delta, { input_tokens: 0, output_tokens: 4, total_tokens: 4 });
});

test("defaults non-Codex runtime adapters to plain output parsing", () => {
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
agent_runtime:
  provider: opencode
  command: opencode run --prompt-file "$SYMPHONY_PROMPT_FILE"
`
		);
		const config = loadConfig({ workflowPath, env: { LINEAR_API_KEY: "linear-token", TARGET_REPO_ROOT: dir } });

		assert.equal(config.agent_runtime.provider, "opencode");
		assert.equal(config.agent_runtime.event_format, "plain");
		assert.deepEqual(validateDispatchConfig(config), []);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("supports OpenCode and Claude Code wrapper configs", () => {
	const dir = tempDir();
	try {
		for (const [provider, command] of [
			["opencode", 'bash "$SYMPHONY_HOME/scripts/symphony-opencode-run.sh"'],
			["claude-code", 'bash "$SYMPHONY_HOME/scripts/symphony-claude-run.sh"']
		]) {
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
  root: tmp/symphony-${provider}
agent_runtime:
  provider: ${provider}
  command: ${command}
`
			);
			const config = loadConfig({ workflowPath, env: { LINEAR_API_KEY: "linear-token", TARGET_REPO_ROOT: dir } });

			assert.equal(config.agent_runtime.provider, provider);
			assert.equal(config.agent_runtime.event_format, "plain");
			assert.deepEqual(validateDispatchConfig(config), []);
		}
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("supports Cursor CLI as a plain-output adapter", () => {
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
agent_runtime:
  provider: cursor-cli
  command: bash "$SYMPHONY_HOME/scripts/symphony-cursor-run.sh"
`
		);
		const config = loadConfig({ workflowPath, env: { LINEAR_API_KEY: "linear-token", TARGET_REPO_ROOT: dir } });

		assert.equal(config.agent_runtime.provider, "cursor-cli");
		assert.equal(config.agent_runtime.event_format, "plain");
		assert.deepEqual(validateDispatchConfig(config), []);
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

test("repository sync runs best-effort Graphite cleanup steps", () => {
	const dir = tempDir();
	const originalExecFileSync = childProcess.execFileSync;
	const commands = [];
	const events = [];
	try {
		fs.mkdirSync(path.join(dir, ".git"));
		childProcess.execFileSync = (command, args) => {
			commands.push([command, ...args].join(" "));
			return Buffer.from("");
		};

		const result = runRepositorySync(
			{
				repository: { root: dir, base_branch: "main", sync_on_tick: true },
				hooks: { timeout_ms: 1000 }
			},
			(event) => events.push(event)
		);

		assert.deepEqual(result, { skipped: false, errors: [] });
		assert.deepEqual(commands, ["git fetch origin main --quiet", "git worktree prune", "sh -lc command -v gt >/dev/null 2>&1", "gt sync"]);
		assert.deepEqual(events, [
			"repository_sync_starting",
			"repository_sync_step_completed",
			"repository_sync_step_completed",
			"repository_sync_step_completed",
			"repository_sync_step_completed",
			"repository_sync_completed"
		]);
	} finally {
		childProcess.execFileSync = originalExecFileSync;
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("repository sync can be disabled per workflow", () => {
	const events = [];
	const result = runRepositorySync({ repository: { sync_on_tick: false } }, (event) => events.push(event));

	assert.deepEqual(result, { skipped: true, errors: [] });
	assert.deepEqual(events, ["repository_sync_skipped"]);
});

test("renders prompt variables strictly", () => {
	const issue = normalizeIssue({ id: "1", identifier: "TASK-1", title: "Wire it", description: "Ticket body", state: { name: "Todo" }, priority: 1 });

	assert.equal(renderPrompt("Do {{ issue.identifier }}: {{ issue.title }}", { issue }), "Do TASK-1: Wire it");
	assert.equal(renderPrompt("Body: {{ issue.description }}", { issue }), "Body: Ticket body");
	assert.equal(renderPrompt("Comments: {{ issue.recent_comments }}", { issue: { ...issue, recent_comments: "Use the ES match list." } }), "Comments: Use the ES match list.");
	assert.equal(renderPrompt("GitHub: {{ issue.recent_github_comments }}", { issue: { ...issue, recent_github_comments: "Address the review comment." } }), "GitHub: Address the review comment.");
	assert.throws(() => renderPrompt("{{ issue.missing }}", { issue }), /unknown prompt variable/);
	assert.throws(() => renderPrompt("{{ issue.title | upcase }}", { issue }), /unsupported prompt filter/);
});

test("allows a blocked issue to stack on exactly one available blocker branch", () => {
	const dir = tempDir();
	try {
		initGitRepo(dir);
		const config = {
			tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done"] },
			repository: { root: dir, branch_prefix: "symphony" },
			agent: { max_concurrent_agents: 1, max_concurrent_agents_by_state: {} }
		};
		const orchestrator = new SymphonyOrchestrator({ config, tracker: {}, runner: {}, workspaceManager: {}, logger: () => {} });
		const blocker = normalizeIssue({ id: "1", identifier: "TASK-1", title: "Base change", state: { name: "In Progress" } });
		const blocked = normalizeIssue({
			id: "2",
			identifier: "TASK-2",
			title: "Dependent change",
			state: { name: "Todo" },
			blocked_by: [blocker]
		});

		assert.equal(orchestrator.isEligible(blocked), false);
		childProcess.execFileSync("git", ["branch", "symphony-task-1"], { cwd: dir });

		assert.deepEqual(orchestrator.stackParentFor(blocked), { issue: blocker, branch: "symphony-task-1" });
		assert.equal(orchestrator.isEligible(blocked), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("keeps issues with multiple active blockers ineligible", () => {
	const dir = tempDir();
	try {
		initGitRepo(dir);
		const config = {
			tracker: { active_states: ["Todo", "In Progress", "In Review"], terminal_states: ["Done"] },
			repository: { root: dir, branch_prefix: "symphony" },
			agent: { max_concurrent_agents: 1, max_concurrent_agents_by_state: {} }
		};
		const orchestrator = new SymphonyOrchestrator({ config, tracker: {}, runner: {}, workspaceManager: {}, logger: () => {} });
		const firstBlocker = normalizeIssue({ id: "1", identifier: "TASK-1", title: "First base change", state: { name: "In Review" } });
		const secondBlocker = normalizeIssue({ id: "2", identifier: "TASK-2", title: "Second base change", state: { name: "In Review" } });
		const blocked = normalizeIssue({
			id: "3",
			identifier: "TASK-3",
			title: "Fan-in integration",
			state: { name: "Todo" },
			blocked_by: [firstBlocker, secondBlocker]
		});

		childProcess.execFileSync("git", ["branch", "symphony-task-1"], { cwd: dir });

		assert.deepEqual(orchestrator.stackParentFor(blocked), { issue: firstBlocker, branch: "symphony-task-1" });
		assert.equal(orchestrator.isEligible(blocked), false);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("allows multi-blocked issues once all but one blocker are terminal", () => {
	const dir = tempDir();
	try {
		initGitRepo(dir);
		const config = {
			tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done"] },
			repository: { root: dir, branch_prefix: "symphony" },
			agent: { max_concurrent_agents: 1, max_concurrent_agents_by_state: {} }
		};
		const orchestrator = new SymphonyOrchestrator({ config, tracker: {}, runner: {}, workspaceManager: {}, logger: () => {} });
		const remainingBlocker = normalizeIssue({ id: "1", identifier: "TASK-1", title: "Remaining base change", state: { name: "In Progress" } });
		const doneBlocker = normalizeIssue({ id: "2", identifier: "TASK-2", title: "Merged base change", state: { name: "Done" } });
		const blocked = normalizeIssue({
			id: "3",
			identifier: "TASK-3",
			title: "Final integration",
			state: { name: "Todo" },
			blocked_by: [remainingBlocker, doneBlocker]
		});

		childProcess.execFileSync("git", ["branch", "symphony-task-1"], { cwd: dir });

		assert.deepEqual(orchestrator.stackParentFor(blocked), { issue: remainingBlocker, branch: "symphony-task-1" });
		assert.equal(orchestrator.isEligible(blocked), true);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});

test("selects non-workpad Linear comments added after the latest workpad update", () => {
	const comments = [
		{ id: "old", body: "old instruction", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", user: { name: "Jai" } },
		{ id: "workpad", body: "<!-- marker -->\n## Symphony Workpad", createdAt: "2026-01-01T00:01:00.000Z", updatedAt: "2026-01-01T00:02:00.000Z" },
		{ id: "new", body: "do not send every fun fact to the LLM", createdAt: "2026-01-01T00:03:00.000Z", updatedAt: "2026-01-01T00:03:00.000Z", user: { name: "Jai" } }
	];

	assert.deepEqual(
		selectPromptComments(comments, "<!-- marker -->").map((comment) => comment.id),
		["new"]
	);
});

test("selects GitHub PR feedback newer than the branch update", () => {
	const payload = {
		data: {
			repository: {
				pullRequest: {
					comments: {
						nodes: [
							{ body: "old comment", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", author: { login: "reviewer" }, url: "https://example.test/old" },
							{ body: "new PR comment", createdAt: "2026-01-01T00:04:00.000Z", updatedAt: "2026-01-01T00:04:00.000Z", author: { login: "reviewer" }, url: "https://example.test/new" }
						]
					},
					reviews: {
						nodes: [
							{
								body: "",
								submittedAt: "2026-01-01T00:05:00.000Z",
								author: { login: "greptile" },
								comments: {
									nodes: [
										{
											body: "inline fix",
											path: "src/file.ts",
											line: 12,
											createdAt: "2026-01-01T00:05:00.000Z",
											updatedAt: "2026-01-01T00:05:00.000Z",
											author: { login: "greptile" },
											url: "https://example.test/inline"
										}
									]
								}
							}
						]
					}
				}
			}
		}
	};

	const feedback = selectGitHubFeedbackSince(flattenGitHubFeedbackPayload(payload), "2026-01-01T00:03:00.000Z");
	assert.deepEqual(
		feedback.map((item) => item.body),
		["new PR comment", "inline fix"]
	);
	assert.deepEqual(
		feedback.map((item) => item.author),
		["reviewer", "greptile"]
	);
	assert.match(formatGitHubFeedback(feedback), /reviewer/);
	assert.match(formatGitHubFeedback(feedback), /greptile/);
	assert.match(formatGitHubFeedback(feedback), /src\/file\.ts:12/);
	assert.match(formatGitHubFeedback(feedback), /https:\/\/example\.test\/inline/);
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

test("allows blocked issues to stack on an available blocker branch", () => {
	const dir = tempDir();
	try {
		childProcess.execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
		childProcess.execFileSync("git", ["config", "user.email", "symphony@example.test"], { cwd: dir });
		childProcess.execFileSync("git", ["config", "user.name", "Symphony Test"], { cwd: dir });
		fs.writeFileSync(path.join(dir, "README.md"), "test\n");
		childProcess.execFileSync("git", ["add", "README.md"], { cwd: dir });
		childProcess.execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, stdio: "ignore" });

		const config = {
			tracker: { active_states: ["Todo", "In Progress"], terminal_states: ["Done"] },
			repository: { root: dir, branch_prefix: "symphony" }
		};
		const orchestrator = new SymphonyOrchestrator({ config, tracker: {}, runner: {}, workspaceManager: {}, logger: () => {} });
		const blocker = normalizeIssue({ id: "1", identifier: "TASK-1", title: "Base change", state: { name: "In Progress" } });
		const blocked = normalizeIssue({
			id: "2",
			identifier: "TASK-2",
			title: "Dependent change",
			state: { name: "Todo" },
			blocked_by: [blocker]
		});

		assert.equal(orchestrator.isEligible(blocked), false);
		childProcess.execFileSync("git", ["branch", "symphony-task-1"], { cwd: dir });

		assert.deepEqual(orchestrator.stackParentFor(blocked), { issue: blocker, branch: "symphony-task-1" });
		assert.equal(orchestrator.isEligible(blocked), true);
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

	const created = await tracker.ensureWorkpadComment("issue-1", "<!-- marker -->", "<!-- marker -->\n## Symphony Workpad");
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
	assert.match(body, /## Symphony Workpad/);
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
			agent_totals: { total_tokens: 42, seconds_running: 7 },
			codex_totals: { total_tokens: 42, seconds_running: 7 }
		};

	assert.equal(classifyLifecycleState(config, "Human Review"), "human_review");
	assert.equal(classifyLifecycleState(config, null, "retrying"), "rework");
	assert.match(renderDashboard(snapshot), /Symphony Agent/);
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
