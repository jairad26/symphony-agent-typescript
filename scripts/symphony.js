#!/usr/bin/env node
"use strict";

const childProcess = require("node:child_process");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const defaultWorkflowPath = path.join(root, "WORKFLOW.md");
const defaultLocalEnvPath = path.join(root, ".env.local");

const DEFAULTS = {
	tracker: {
		endpoint: "https://api.linear.app/graphql",
		active_states: ["Todo", "In Progress"],
		terminal_states: ["Closed", "Cancelled", "Canceled", "Duplicate", "Done"],
		page_size: 50,
		timeout_ms: 30000,
		workpad: {
			enabled: true,
			marker: "<!-- symphony-agent-workpad -->"
		}
	},
	polling: { interval_ms: 30000 },
	repository: {
		root: ".",
		base_branch: "main",
		branch_prefix: "symphony",
		env_file: ".env.local",
		link_node_modules: true,
		sync_on_tick: true
	},
	workspace: { root: path.join(os.tmpdir(), "symphony_workspaces") },
	hooks: { timeout_ms: 60000 },
	agent: {
		max_concurrent_agents: 10,
		max_turns: 20,
		max_retry_backoff_ms: 300000,
		max_concurrent_agents_by_state: {}
	},
	agent_runtime: {
		provider: "codex",
		command: "codex app-server",
		event_format: "codex-json",
		turn_timeout_ms: 3600000,
		read_timeout_ms: 5000,
		stall_timeout_ms: 300000
	},
	lifecycle: {
		todo_states: ["Todo"],
		in_progress_states: ["In Progress"],
		human_review_states: ["Human Review", "In Review"],
		rework_states: ["Rework"],
		merging_states: ["Merging"],
		done_states: ["Done", "Closed"]
	},
	codex: {
		command: "codex app-server",
		turn_timeout_ms: 3600000,
		read_timeout_ms: 5000,
		stall_timeout_ms: 300000
	}
};

function parseArgs(argv) {
	const args = { _: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (!arg.startsWith("--")) {
			args._.push(arg);
			continue;
		}
		const key = arg.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			args[key] = true;
			continue;
		}
		args[key] = next;
		index += 1;
	}
	return args;
}

function deepMerge(base, override) {
	if (!override || typeof override !== "object" || Array.isArray(override)) {
		return override === undefined ? base : override;
	}
	const merged = { ...(base || {}) };
	for (const [key, value] of Object.entries(override)) {
		merged[key] = deepMerge(merged[key], value);
	}
	return merged;
}

function parseScalar(value) {
	const trimmed = String(value).trim();
	if (trimmed === "") {
		return "";
	}
	if (trimmed === "null") {
		return null;
	}
	if (trimmed === "true") {
		return true;
	}
	if (trimmed === "false") {
		return false;
	}
	if (/^-?\d+$/.test(trimmed)) {
		return Number(trimmed);
	}
	if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
		return trimmed.slice(1, -1);
	}
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		const body = trimmed.slice(1, -1).trim();
		if (!body) {
			return [];
		}
		return body.split(",").map((item) => parseScalar(item.trim()));
	}
	return trimmed;
}

function parseFrontMatterYaml(yaml) {
	const rootObject = {};
	const stack = [{ indent: -1, value: rootObject }];
	const lines = yaml.replace(/\r\n/g, "\n").split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index];
		if (!rawLine.trim() || rawLine.trim().startsWith("#")) {
			continue;
		}
		const indent = rawLine.match(/^ */)[0].length;
		const line = rawLine.trim();
		const match = line.match(/^([^:]+):(.*)$/);
		if (!match) {
			throw new Error(`unsupported WORKFLOW.md front matter line: ${line}`);
		}
		const key = match[1].trim();
		const rest = match[2].trim();
		while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
			stack.pop();
		}
		const parent = stack[stack.length - 1].value;
		if (rest === "") {
			parent[key] = {};
			stack.push({ indent, value: parent[key] });
			continue;
		}
		if (rest === "|") {
			const blockLines = [];
			const blockIndent = indent + 2;
			while (index + 1 < lines.length) {
				const nextLine = lines[index + 1];
				if (nextLine.trim() && nextLine.match(/^ */)[0].length < blockIndent) {
					break;
				}
				index += 1;
				blockLines.push(nextLine.slice(Math.min(blockIndent, nextLine.length)));
			}
			parent[key] = blockLines.join("\n").replace(/\n$/, "");
			continue;
		}
		parent[key] = parseScalar(rest);
	}

	return rootObject;
}

function readWorkflowFile(file = defaultWorkflowPath) {
	const text = fs.readFileSync(file, "utf8");
	const match = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
	if (!match) {
		return {
			path: path.resolve(file),
			frontMatter: {},
			promptTemplate: text.trim()
		};
	}
	return {
		path: path.resolve(file),
		frontMatter: parseFrontMatterYaml(match[1]),
		promptTemplate: match[2].trim()
	};
}

function resolveSecret(value, env = process.env) {
	if (typeof value === "string" && value.startsWith("$")) {
		const resolved = env[value.slice(1)];
		return expandEnvValue(resolved, env);
	}
	return expandEnvValue(value, env);
}

function expandEnvValue(value, env = process.env) {
	if (typeof value !== "string") {
		return value;
	}
	return value
		.replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*):-([^}]*)\}$/, (match, name, fallback) => (env[name] && env[name] !== match ? env[name] : fallback))
		.replace(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/, (_match, name) => env[name] || "");
}

function parseEnvFile(text) {
	const values = {};
	for (const rawLine of String(text).split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) {
			continue;
		}
		const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match) {
			continue;
		}
		let value = match[2].trim();
		const isDoubleQuoted = value.startsWith('"') && value.endsWith('"') && value.length >= 2;
		const isSingleQuoted = value.startsWith("'") && value.endsWith("'") && value.length >= 2;
		if (!isDoubleQuoted && !isSingleQuoted) {
			const commentIndex = value.search(/\s#/);
			if (commentIndex >= 0) {
				value = value.slice(0, commentIndex).trim();
			}
		}
		if (isDoubleQuoted || isSingleQuoted) {
			value = value.slice(1, -1);
		}
		values[match[1]] = value;
	}
	return values;
}

function loadLocalEnv({ env = process.env, envPath = defaultLocalEnvPath } = {}) {
	if (!fs.existsSync(envPath)) {
		return env;
	}
	const localValues = parseEnvFile(fs.readFileSync(envPath, "utf8"));
	return { ...localValues, ...env };
}

function expandPathValue(value, env = process.env) {
	return String(value || "")
		.replace(/^~(?=$|\/)/, os.homedir())
		.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, name) => env[name] || match);
}

function resolvePath(value, baseDir = root, env = process.env) {
	const expanded = expandPathValue(value, env);
	if (path.isAbsolute(expanded)) {
		return path.normalize(expanded);
	}
	return path.resolve(baseDir, expanded);
}

function loadConfig({ workflowPath = defaultWorkflowPath, env = loadLocalEnv() } = {}) {
	const workflowFile = readWorkflowFile(workflowPath);
	const config = deepMerge(DEFAULTS, workflowFile.frontMatter);
	config.agent_runtime = normalizeAgentRuntimeConfig(config, workflowFile.frontMatter);
	config.tracker.api_key = resolveSecret(config.tracker.api_key || "$LINEAR_API_KEY", env);
	config.tracker.assignee_email = resolveSecret(config.tracker.assignee_email, env);
	config.repository.root = resolvePath(config.repository.root, path.dirname(workflowFile.path), env);
	config.workspace.root = resolvePath(config.workspace.root, path.dirname(workflowFile.path), env);
	config.workflow_path = workflowFile.path;
	config.prompt_template = workflowFile.promptTemplate;
	return config;
}

function normalizeAgentRuntimeConfig(config, frontMatter = {}) {
	const legacyCodex = frontMatter.codex;
	if (!frontMatter.agent_runtime && legacyCodex) {
		return {
			...DEFAULTS.agent_runtime,
			provider: "codex",
			event_format: "codex-json",
			...legacyCodex
		};
	}
	const runtime = config.agent_runtime || {};
	const provider = runtime.provider || "generic-cli";
	const eventFormat =
		frontMatter.agent_runtime && !Object.prototype.hasOwnProperty.call(frontMatter.agent_runtime, "event_format")
			? defaultEventFormatForProvider(provider)
			: runtime.event_format || defaultEventFormatForProvider(provider);
	return {
		...runtime,
		provider,
		event_format: eventFormat
	};
}

function defaultEventFormatForProvider(provider) {
	return provider === "codex" ? "codex-json" : "plain";
}

function validateDispatchConfig(config, options = {}) {
	const requireSecrets = options.requireSecrets !== false;
	const failures = [];
	if (!config.tracker || config.tracker.kind !== "linear") {
		failures.push("tracker.kind must be linear");
	}
	if (requireSecrets && !config.tracker?.api_key) {
		failures.push("tracker.api_key must be set after $VAR resolution");
	}
	if (!config.tracker?.project_slug) {
		failures.push("tracker.project_slug must be set");
	}
	if (config.tracker?.project_slug === "your-linear-project-slug-id") {
		failures.push("tracker.project_slug must be changed from the example placeholder");
	}
	if (!config.repository?.root) {
		failures.push("repository.root must be set");
	}
	if (String(config.repository?.root || "").includes("$")) {
		failures.push("repository.root contains an unresolved $VAR");
	}
	if (!config.repository?.base_branch) {
		failures.push("repository.base_branch must be set");
	}
	for (const key of ["on_dispatch_state_id", "on_pr_open_state_id"]) {
		const value = config.tracker?.state_transitions?.[key];
		if (value !== undefined && typeof value !== "string") {
			failures.push(`tracker.state_transitions.${key} must be a Linear state id string`);
		}
	}
	if (!config.agent_runtime?.command) {
		failures.push("agent_runtime.command must be set");
	}
	if (!["codex", "opencode", "claude-code", "cursor-cli", "generic-cli"].includes(config.agent_runtime?.provider)) {
		failures.push("agent_runtime.provider must be one of codex, opencode, claude-code, cursor-cli, generic-cli");
	}
	if (!["codex-json", "plain"].includes(config.agent_runtime?.event_format)) {
		failures.push("agent_runtime.event_format must be one of codex-json, plain");
	}
	if (!Number.isInteger(config.polling?.interval_ms) || config.polling.interval_ms < 1) {
		failures.push("polling.interval_ms must be a positive integer");
	}
	if (!Number.isInteger(config.agent?.max_concurrent_agents) || config.agent.max_concurrent_agents < 1) {
		failures.push("agent.max_concurrent_agents must be a positive integer");
	}
	if (!Number.isInteger(config.agent?.max_turns) || config.agent.max_turns < 1) {
		failures.push("agent.max_turns must be a positive integer");
	}
	if (!Number.isInteger(config.agent?.max_retry_backoff_ms) || config.agent.max_retry_backoff_ms < 1000) {
		failures.push("agent.max_retry_backoff_ms must be at least 1000");
	}
	return failures;
}

function normalizeStateName(value) {
	return String(value || "").trim();
}

function normalizeIssue(issue) {
	const state = typeof issue.state === "string" ? issue.state : issue.state?.name;
	const labels = Array.isArray(issue.labels?.nodes) ? issue.labels.nodes.map((label) => label.name) : issue.labels;
	const assignee = issue.assignee
		? {
				id: issue.assignee.id || null,
				name: issue.assignee.name || null,
				email: issue.assignee.email || null
			}
		: null;
	const blockedBy =
		issue.blocked_by ||
		(issue.relations?.nodes || [])
			.filter((relation) => relation.type === "blocked_by" && relation.relatedIssue)
			.map((relation) => normalizeIssue(relation.relatedIssue));
	return {
		id: issue.id,
		identifier: issue.identifier,
		title: issue.title,
		description: issue.description || "",
		state: normalizeStateName(state),
		priority: Number.isInteger(issue.priority) ? issue.priority : null,
		created_at: issue.created_at || issue.createdAt || null,
		updated_at: issue.updated_at || issue.updatedAt || null,
		assignee,
		labels: Array.isArray(labels) ? labels.map((label) => String(label).toLowerCase()) : [],
		blocked_by: Array.isArray(blockedBy) ? blockedBy : [],
		comments: Array.isArray(issue.comments) ? issue.comments : [],
		recent_comments: issue.recent_comments || "",
		github_comments: Array.isArray(issue.github_comments) ? issue.github_comments : [],
		recent_github_comments: issue.recent_github_comments || "",
		raw: issue
	};
}

function branchSlugForIssueIdentifier(identifier) {
	return String(identifier || "symphony-issue")
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/-+$/g, "");
}

function branchNameForIssue(config, identifier) {
	const branchPrefix = config.repository?.branch_prefix || DEFAULTS.repository.branch_prefix;
	return `${branchPrefix}-${branchSlugForIssueIdentifier(identifier)}`;
}

function gitBranchExists(repoRoot, branchName) {
	if (!repoRoot || !branchName) {
		return false;
	}
	try {
		childProcess.execFileSync("git", ["-C", repoRoot, "show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], { stdio: "ignore" });
		return true;
	} catch (_error) {
		return false;
	}
}

function runRepositorySync(config, logger = defaultLogger) {
	if (config.repository?.sync_on_tick === false) {
		logger("repository_sync_skipped", { reason: "disabled" });
		return { skipped: true, errors: [] };
	}
	const repoRoot = path.resolve(config.repository?.root || ".");
	if (!fs.existsSync(path.join(repoRoot, ".git"))) {
		logger("repository_sync_skipped", { reason: "missing_git_repository", repo_root: repoRoot });
		return { skipped: true, errors: [] };
	}
	const errors = [];
	const timeout = config.hooks?.timeout_ms || DEFAULTS.hooks.timeout_ms;
	const baseBranch = config.repository?.base_branch || DEFAULTS.repository.base_branch;
	const runStep = (step, command, args, options = {}) => {
		try {
			childProcess.execFileSync(command, args, {
				cwd: repoRoot,
				timeout,
				stdio: "pipe",
				...options
			});
			logger("repository_sync_step_completed", { step });
			return true;
		} catch (error) {
			errors.push(`${step}: ${error.message}`);
			logger("repository_sync_step_failed", { step, error: error.message });
			return false;
		}
	};
	const graphiteAvailable = () => {
		try {
			childProcess.execFileSync("sh", ["-lc", "command -v gt >/dev/null 2>&1"], {
				cwd: repoRoot,
				timeout,
				stdio: "pipe"
			});
			logger("repository_sync_step_completed", { step: "detect_graphite" });
			return true;
		} catch (_error) {
			logger("repository_sync_step_skipped", { step: "gt_sync", reason: "graphite_unavailable" });
			return false;
		}
	};

	logger("repository_sync_starting", { repo_root: repoRoot, base_branch: baseBranch });
	runStep("git_fetch_base", "git", ["fetch", "origin", baseBranch, "--quiet"]);
	runStep("git_worktree_prune", "git", ["worktree", "prune"]);
	if (graphiteAvailable()) {
		runStep("gt_sync", "gt", ["sync"]);
	}
	logger(errors.length ? "repository_sync_completed_with_errors" : "repository_sync_completed", { errors });
	return { skipped: false, errors };
}

function normalizeIssueComment(comment) {
	const author = comment.user || comment.author || null;
	return {
		id: comment.id,
		body: String(comment.body || "").trim(),
		created_at: comment.created_at || comment.createdAt || null,
		updated_at: comment.updated_at || comment.updatedAt || null,
		author: author
			? {
					name: author.name || null,
					email: author.email || null
				}
			: null
	};
}

function isWorkpadComment(comment, marker) {
	const body = String(comment.body || "");
	return body.includes(marker) || body.includes("## Symphony Workpad") || body.includes("## Codex Workpad");
}

function selectPromptComments(comments, marker) {
	const normalized = comments.map(normalizeIssueComment).filter((comment) => comment.body && !isWorkpadComment(comment, marker));
	const workpad = comments.map(normalizeIssueComment).filter((comment) => isWorkpadComment(comment, marker)).sort(compareCommentTime).at(-1);
	if (!workpad?.updated_at) {
		return normalized.slice(-10);
	}
	const cutoff = Date.parse(workpad.updated_at) || 0;
	return normalized.filter((comment) => {
		const timestamp = Date.parse(comment.updated_at || comment.created_at || "") || 0;
		return timestamp > cutoff;
	}).slice(-10);
}

function compareCommentTime(left, right) {
	const leftTime = Date.parse(left.updated_at || left.created_at || "") || 0;
	const rightTime = Date.parse(right.updated_at || right.created_at || "") || 0;
	return leftTime - rightTime;
}

function formatPromptComments(comments) {
	if (!comments.length) {
		return "No new Linear comments since the last Symphony workpad update.";
	}
	return comments
		.map((comment, index) => {
			const author = comment.author?.name || comment.author?.email || "Unknown";
			const timestamp = comment.updated_at || comment.created_at || "unknown time";
			return `Comment ${index + 1} (${author}, ${timestamp}):\n${comment.body}`;
		})
		.join("\n\n---\n\n");
}

function normalizeGitHubAuthor(author) {
	if (!author) return "Unknown";
	return author.login || author.name || author.email || "Unknown";
}

function normalizeGitHubFeedbackItem(item) {
	return {
		type: item.type || "comment",
		body: String(item.body || "").trim(),
		author: normalizeGitHubAuthor(item.author),
		created_at: item.created_at || item.createdAt || item.submittedAt || null,
		updated_at: item.updated_at || item.updatedAt || item.submittedAt || item.created_at || item.createdAt || null,
		url: item.url || "",
		path: item.path || "",
		line: item.line || null,
		state: item.state || ""
	};
}

function flattenGitHubFeedbackPayload(payload) {
	const pullRequest = payload?.data?.repository?.pullRequest || payload?.repository?.pullRequest || payload?.pullRequest || {};
	const feedback = [];
	for (const comment of pullRequest.comments?.nodes || []) {
		feedback.push(normalizeGitHubFeedbackItem({ ...comment, type: "pr_comment" }));
	}
	for (const review of pullRequest.reviews?.nodes || []) {
		if (review.body) {
			feedback.push(
				normalizeGitHubFeedbackItem({
					...review,
					type: "review",
					created_at: review.submittedAt,
					updated_at: review.updatedAt || review.submittedAt
				})
			);
		}
		for (const comment of review.comments?.nodes || []) {
			feedback.push(
				normalizeGitHubFeedbackItem({
					...comment,
					type: "review_comment"
				})
			);
		}
	}
	return feedback.filter((item) => item.body);
}

function selectGitHubFeedbackSince(feedback, cutoffIso, limit = 20) {
	const cutoff = Date.parse(cutoffIso || "") || 0;
	return feedback
		.filter((item) => item.body)
		.filter((item) => {
			if (!cutoff) return true;
			const timestamp = Date.parse(item.updated_at || item.created_at || "") || 0;
			return timestamp > cutoff;
		})
		.sort(compareCommentTime)
		.slice(-limit);
}

function formatGitHubFeedback(feedback) {
	if (!feedback.length) {
		return "No GitHub PR comments found since the last branch update.";
	}
	return feedback
		.map((item, index) => {
			const timestamp = item.updated_at || item.created_at || "unknown time";
			const location = item.path ? ` ${item.path}${item.line ? `:${item.line}` : ""}` : "";
			const url = item.url ? `\n${item.url}` : "";
			return `GitHub ${index + 1} (${item.type}${location}, ${item.author}, ${timestamp}):${url}\n${item.body}`;
		})
		.join("\n\n---\n\n");
}

class LinearTracker {
	constructor(config, fetchImpl = global.fetch) {
		this.config = config;
		this.fetchImpl = fetchImpl;
	}

	async postGraphql(query, variables) {
		if (!this.fetchImpl) {
			throw Object.assign(new Error("global fetch is unavailable"), { category: "linear_api_request" });
		}
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.config.tracker.timeout_ms || DEFAULTS.tracker.timeout_ms);
		let response;
		try {
			response = await this.fetchImpl(this.config.tracker.endpoint, {
				method: "POST",
				headers: {
					"content-type": "application/json",
					authorization: this.config.tracker.api_key
				},
				body: JSON.stringify({ query, variables }),
				signal: controller.signal
			});
		} catch (error) {
			throw Object.assign(new Error(`Linear API request failed: ${error.message}`), { category: "linear_api_request" });
		} finally {
			clearTimeout(timeout);
		}
		if (!response.ok) {
			throw Object.assign(new Error(`Linear API returned ${response.status}`), { category: "linear_api_status" });
		}
		const payload = await response.json();
		if (payload.errors?.length) {
			throw Object.assign(new Error(`Linear GraphQL errors: ${payload.errors.map((error) => error.message).join("; ")}`), { category: "linear_graphql_errors" });
		}
		return payload.data;
	}

	assigneeFilter() {
		const email = this.config.tracker.assignee_email;
		if (!email) {
			return "";
		}
		return ", assignee: { email: { eqIgnoreCase: $assigneeEmail } }";
	}

	assigneeVariables() {
		const email = this.config.tracker.assignee_email;
		return email ? { assigneeEmail: email } : {};
	}

	async fetchCandidateIssues() {
		const pageSize = this.config.tracker.page_size || DEFAULTS.tracker.page_size;
		const query = `
query SymphonyCandidateIssues($projectSlug: String!, $activeStates: [String!], $assigneeEmail: String, $first: Int!, $after: String) {
  issues(
    first: $first
    after: $after
    filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $activeStates } }${this.assigneeFilter()} }
  ) {
    nodes {
      id
      identifier
      title
      description
      priority
      createdAt
      updatedAt
      state { name }
      assignee { id name email }
      labels { nodes { name } }
      relations { nodes { type relatedIssue { id identifier title description state { name } assignee { id name email } } } }
    }
    pageInfo { hasNextPage endCursor }
  }
}`;
		const issues = [];
		let after = null;
		for (;;) {
			const data = await this.postGraphql(query, {
				projectSlug: this.config.tracker.project_slug,
				activeStates: this.config.tracker.active_states,
				...this.assigneeVariables(),
				first: pageSize,
				after
			});
			const page = data?.issues;
			if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
				throw Object.assign(new Error("Linear candidate issue payload is malformed"), { category: "linear_unknown_payload" });
			}
			issues.push(...page.nodes.map(normalizeIssue));
			if (!page.pageInfo.hasNextPage) {
				return issues;
			}
			if (!page.pageInfo.endCursor) {
				throw Object.assign(new Error("Linear pagination is missing endCursor"), { category: "linear_missing_end_cursor" });
			}
			after = page.pageInfo.endCursor;
		}
	}

	async fetchIssuesByStates(stateNames) {
		const query = `
query SymphonyIssuesByStates($projectSlug: String!, $states: [String!], $assigneeEmail: String, $first: Int!, $after: String) {
  issues(first: $first, after: $after, filter: { project: { slugId: { eq: $projectSlug } }, state: { name: { in: $states } }${this.assigneeFilter()} }) {
    nodes { id identifier title description priority createdAt updatedAt state { name } assignee { id name email } }
    pageInfo { hasNextPage endCursor }
  }
}`;
		const issues = [];
		let after = null;
		for (;;) {
			const data = await this.postGraphql(query, {
				projectSlug: this.config.tracker.project_slug,
				states: stateNames,
				...this.assigneeVariables(),
				first: this.config.tracker.page_size || DEFAULTS.tracker.page_size,
				after
			});
			const page = data?.issues;
			if (!page || !Array.isArray(page.nodes) || !page.pageInfo) {
				throw Object.assign(new Error("Linear issues-by-states payload is malformed"), { category: "linear_unknown_payload" });
			}
			issues.push(...page.nodes.map(normalizeIssue));
			if (!page.pageInfo.hasNextPage) {
				return issues;
			}
			if (!page.pageInfo.endCursor) {
				throw Object.assign(new Error("Linear pagination is missing endCursor"), { category: "linear_missing_end_cursor" });
			}
			after = page.pageInfo.endCursor;
		}
	}

	async fetchIssueStatesByIds(issueIds) {
		const query = `
query SymphonyIssueStates($ids: [ID!]) {
  issues(first: 100, filter: { id: { in: $ids } }) {
    nodes { id identifier title description priority createdAt updatedAt state { name } assignee { id name email } }
  }
}`;
		const data = await this.postGraphql(query, { ids: issueIds });
		const states = new Map();
		for (const issue of data?.issues?.nodes || []) {
			const normalized = normalizeIssue(issue);
			states.set(normalized.id, normalized);
		}
		return states;
	}

	async updateIssueState(issueId, stateId) {
		const query = `
mutation SymphonyIssueUpdate($id: String!, $input: IssueUpdateInput!) {
  issueUpdate(id: $id, input: $input) {
    success
    issue { id identifier title description priority createdAt updatedAt state { name } assignee { id name email } }
  }
}`;
		const data = await this.postGraphql(query, { id: issueId, input: { stateId } });
		if (!data?.issueUpdate?.success || !data.issueUpdate.issue) {
			throw Object.assign(new Error("Linear issueUpdate payload is malformed"), { category: "linear_unknown_payload" });
		}
		return normalizeIssue(data.issueUpdate.issue);
	}

	async fetchIssueComments(issueId) {
		const query = `
query SymphonyIssueComments($id: String!) {
  issue(id: $id) {
    comments(first: 50) {
      nodes { id body createdAt updatedAt user { name email } }
    }
  }
}`;
		const data = await this.postGraphql(query, { id: issueId });
		const comments = data?.issue?.comments?.nodes;
		if (!Array.isArray(comments)) {
			throw Object.assign(new Error("Linear issue comments payload is malformed"), { category: "linear_unknown_payload" });
		}
		return comments;
	}

	async createIssueComment(issueId, body) {
		const query = `
mutation SymphonyCommentCreate($input: CommentCreateInput!) {
  commentCreate(input: $input) {
    success
    comment { id body }
  }
}`;
		const data = await this.postGraphql(query, { input: { issueId, body } });
		if (!data?.commentCreate?.success || !data.commentCreate.comment) {
			throw Object.assign(new Error("Linear commentCreate payload is malformed"), { category: "linear_unknown_payload" });
		}
		return data.commentCreate.comment;
	}

	async updateIssueComment(commentId, body) {
		const query = `
mutation SymphonyCommentUpdate($id: String!, $input: CommentUpdateInput!) {
  commentUpdate(id: $id, input: $input) {
    success
    comment { id body }
  }
}`;
		const data = await this.postGraphql(query, { id: commentId, input: { body } });
		if (!data?.commentUpdate?.success || !data.commentUpdate.comment) {
			throw Object.assign(new Error("Linear commentUpdate payload is malformed"), { category: "linear_unknown_payload" });
		}
		return data.commentUpdate.comment;
	}

	async ensureWorkpadComment(issueId, marker, body) {
		const comments = await this.fetchIssueComments(issueId);
		const existing = comments.find((comment) => isWorkpadComment(comment, marker));
		if (existing) {
			return this.updateIssueComment(existing.id, body);
		}
		return this.createIssueComment(issueId, body);
	}
}

class WorkspaceManager {
	constructor(config, logger = () => {}) {
		this.config = config;
		this.logger = logger;
		this.root = path.resolve(config.workspace.root);
	}

	sanitize(identifier) {
		return String(identifier || "unknown").replace(/[^A-Za-z0-9._-]/g, "_");
	}

	assertInside(workspacePath) {
		const relative = path.relative(this.root, path.resolve(workspacePath));
		if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
			throw new Error(`workspace path escapes workspace root: ${workspacePath}`);
		}
	}

	workspacePath(identifier) {
		const workspacePath = path.join(this.root, this.sanitize(identifier));
		this.assertInside(workspacePath);
		return workspacePath;
	}

	runHook(name, cwd, env = {}) {
		const script = this.config.hooks?.[name];
		if (!script) {
			return;
		}
		this.logger("hook_starting", { hook: name, cwd });
		childProcess.execFileSync("sh", ["-lc", script], {
			cwd,
			env: { ...process.env, ...env },
			timeout: this.config.hooks.timeout_ms || DEFAULTS.hooks.timeout_ms,
			stdio: "pipe"
		});
		this.logger("hook_completed", { hook: name, cwd });
	}

	prepare(issue) {
		fs.mkdirSync(this.root, { recursive: true });
		const workspacePath = this.workspacePath(issue.identifier);
		const createdNow = !fs.existsSync(workspacePath);
		fs.mkdirSync(workspacePath, { recursive: true });
		if (createdNow) {
			this.runHook("after_create", workspacePath, this.hookEnv(issue, workspacePath));
		}
		return { path: workspacePath, key: path.basename(workspacePath), created_now: createdNow };
	}

	remove(issue) {
		const workspacePath = this.workspacePath(issue.identifier);
		if (!fs.existsSync(workspacePath)) {
			return;
		}
		try {
			this.runHook("before_remove", workspacePath, this.hookEnv(issue, workspacePath));
		} catch (error) {
			this.logger("hook_failed_ignored", { hook: "before_remove", issue_id: issue.id, issue_identifier: issue.identifier, error: error.message });
		}
		fs.rmSync(workspacePath, { recursive: true, force: true });
	}

	hookEnv(issue, workspacePath) {
		return {
			SYMPHONY_ISSUE_ID: issue.id,
			SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
			SYMPHONY_WORKSPACE: workspacePath
		};
	}
}

function getByPath(object, dotPath) {
	return dotPath.split(".").reduce((value, key) => (value == null ? undefined : value[key]), object);
}

function renderPrompt(template, context) {
	return String(template).replace(/{{\s*([^}]+?)\s*}}/g, (_match, expression) => {
		if (expression.includes("|")) {
			throw new Error(`unsupported prompt filter in expression: ${expression}`);
		}
		const value = getByPath(context, expression.trim());
		if (value === undefined || value === null) {
			throw new Error(`unknown prompt variable: ${expression.trim()}`);
		}
		return typeof value === "object" ? JSON.stringify(value) : String(value);
	});
}

class AgentRunner {
	constructor(config, logger = () => {}) {
		this.config = config;
		this.logger = logger;
		this.children = new Set();
	}

	adapter() {
		return createAgentAdapter(this.config.agent_runtime || this.config.codex || DEFAULTS.agent_runtime);
	}

	pipeChildOutput(stream, { logStream, sessionId, streamName, onEvent }) {
		stream.setEncoding("utf8");
		let buffered = "";
		stream.on("data", (chunk) => {
			buffered += chunk;
			const lines = buffered.split(/\r?\n/);
			buffered = lines.pop() || "";
			for (const line of lines) {
				this.handleChildOutputLine(line, { logStream, sessionId, streamName, onEvent });
			}
		});
		stream.on("end", () => {
			if (buffered) {
				this.handleChildOutputLine(buffered, { logStream, sessionId, streamName, onEvent });
			}
		});
	}

	handleChildOutputLine(line, { logStream, sessionId, streamName, onEvent }) {
		logStream.write(`${line}\n`);
		const text = line.trim();
		if (!text) {
			return;
		}
		const adapter = this.adapter();
		const parsedEvent = adapter.parseLine(text, { sessionId, streamName });
		if (parsedEvent) {
			onEvent(parsedEvent);
			return;
		}
		const outputEvent = { event: "agent_output", session_id: sessionId, stream: streamName, timestamp: new Date().toISOString(), text };
		if (adapter.event_format === "plain") {
			outputEvent.usage_delta = estimateOutputTokenUsageFromText(text);
		}
		onEvent(outputEvent);
	}

	async run({ issue, workspacePath, prompt, attempt, onEvent }) {
		if (!workspacePath || !path.isAbsolute(path.resolve(workspacePath))) {
			throw Object.assign(new Error("agent workspace path must be absolute"), { status: "Failed" });
		}
		const runtime = this.config.agent_runtime || this.config.codex || DEFAULTS.agent_runtime;
		const command = runtime.command;
		const sessionId = `${issue.identifier}-${Date.now()}`;
		onEvent({ event: "session_started", session_id: sessionId, timestamp: new Date().toISOString() });
		if (command === "symphony dry-run") {
			fs.writeFileSync(path.join(workspacePath, "symphony-prompt.md"), `${prompt}\n`);
			onEvent({ event: "turn_completed", session_id: sessionId, timestamp: new Date().toISOString(), usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 } });
			return { status: "Succeeded", session_id: sessionId, turns: 1 };
		}
		const promptFile = path.join(workspacePath, "symphony-prompt.md");
		const runLogFile = path.join(workspacePath, "agent-run.log");
		fs.writeFileSync(promptFile, `${prompt}\n`);
		fs.writeFileSync(runLogFile, "");
		await new Promise((resolve, reject) => {
			const logStream = fs.createWriteStream(runLogFile, { flags: "a" });
			const child = childProcess.spawn("sh", ["-lc", command], {
				cwd: workspacePath,
				env: {
					...process.env,
					SYMPHONY_PROMPT_FILE: promptFile,
					SYMPHONY_HOME: root,
					SYMPHONY_AGENT_PROVIDER: runtime.provider || "generic-cli",
					SYMPHONY_AGENT_EVENT_FORMAT: runtime.event_format || defaultEventFormatForProvider(runtime.provider || "generic-cli"),
					SYMPHONY_REPO_ROOT: this.config.repository.root,
					SYMPHONY_TARGET_REPO_ROOT: this.config.repository.root,
					SYMPHONY_BASE_BRANCH: this.config.repository.base_branch || DEFAULTS.repository.base_branch,
					SYMPHONY_BRANCH_PREFIX: this.config.repository.branch_prefix || DEFAULTS.repository.branch_prefix,
					SYMPHONY_REPO_ENV_FILE: this.config.repository.env_file || DEFAULTS.repository.env_file,
					SYMPHONY_LINK_NODE_MODULES: this.config.repository.link_node_modules === false ? "false" : "true",
					SYMPHONY_ISSUE_ID: issue.id,
					SYMPHONY_ISSUE_IDENTIFIER: issue.identifier,
					SYMPHONY_WORKPAD_COMMENT_ID: issue.workpad_comment_id || "",
					SYMPHONY_STACK_PARENT_ISSUE_IDENTIFIER: issue.stack_parent?.issue?.identifier || "",
					SYMPHONY_STACK_PARENT_BRANCH: issue.stack_parent?.branch || "",
					SYMPHONY_LINEAR_ENDPOINT: this.config.tracker.endpoint || DEFAULTS.tracker.endpoint,
					SYMPHONY_LINEAR_IN_REVIEW_STATE_ID: this.config.tracker.state_transitions?.on_pr_open_state_id || "",
					LINEAR_API_KEY: this.config.tracker.api_key || process.env.LINEAR_API_KEY || "",
					SYMPHONY_ATTEMPT: String(attempt || "")
				},
				stdio: ["ignore", "pipe", "pipe"]
			});
			this.children.add(child);
			onEvent({ event: "agent_process_started", session_id: sessionId, timestamp: new Date().toISOString(), pid: child.pid, log_file: runLogFile });
			this.pipeChildOutput(child.stdout, { logStream, sessionId, streamName: "stdout", onEvent });
			this.pipeChildOutput(child.stderr, { logStream, sessionId, streamName: "stderr", onEvent });
			const timeout = setTimeout(() => {
				child.kill("SIGTERM");
				logStream.end();
				reject(Object.assign(new Error("agent turn timed out"), { status: "TimedOut" }));
			}, runtime.turn_timeout_ms || DEFAULTS.agent_runtime.turn_timeout_ms);
			child.on("error", (error) => {
				this.children.delete(child);
				clearTimeout(timeout);
				logStream.end();
				reject(Object.assign(error, { status: "Failed" }));
			});
			child.on("exit", (code) => {
				this.children.delete(child);
				clearTimeout(timeout);
				logStream.end();
				if (code === 0) {
					resolve();
				} else {
					reject(Object.assign(new Error(`agent command exited ${code}`), { status: "Failed" }));
				}
			});
		});
		onEvent({ event: "turn_completed", session_id: sessionId, timestamp: new Date().toISOString() });
		return { status: "Succeeded", session_id: sessionId, turns: 1 };
	}

	terminateAll(signal = "SIGTERM") {
		for (const child of this.children) {
			if (!child.killed) {
				child.kill(signal);
			}
		}
	}
}

function createAgentAdapter(runtime = {}) {
	const provider = runtime.provider || "generic-cli";
	const eventFormat = runtime.event_format || defaultEventFormatForProvider(provider);
	return {
		provider,
		event_format: eventFormat,
		parseLine(line, context) {
			if (eventFormat === "codex-json") {
				return parseCodexJsonEvent(line, context);
			}
			return null;
		}
	};
}

function sortCandidates(issues) {
	return [...issues].sort((left, right) => {
		const leftPriority = Number.isInteger(left.priority) ? left.priority : Number.MAX_SAFE_INTEGER;
		const rightPriority = Number.isInteger(right.priority) ? right.priority : Number.MAX_SAFE_INTEGER;
		if (leftPriority !== rightPriority) {
			return leftPriority - rightPriority;
		}
		const leftCreated = Date.parse(left.created_at || "") || Number.MAX_SAFE_INTEGER;
		const rightCreated = Date.parse(right.created_at || "") || Number.MAX_SAFE_INTEGER;
		if (leftCreated !== rightCreated) {
			return leftCreated - rightCreated;
		}
		return String(left.identifier).localeCompare(String(right.identifier));
	});
}

function classifyLifecycleState(config, state, status = null) {
	const lifecycle = config.lifecycle || DEFAULTS.lifecycle;
	const stateName = String(state || "");
	if (status === "retrying") return "rework";
	if ((lifecycle.done_states || []).includes(stateName)) return "done";
	if ((lifecycle.merging_states || []).includes(stateName)) return "merging";
	if ((lifecycle.rework_states || []).includes(stateName)) return "rework";
	if ((lifecycle.human_review_states || []).includes(stateName)) return "human_review";
	if ((lifecycle.in_progress_states || []).includes(stateName)) return "in_progress";
	if ((lifecycle.todo_states || []).includes(stateName)) return "todo";
	return status || "observed";
}

class SymphonyOrchestrator {
	constructor({ config, tracker, runner, workspaceManager, logger = defaultLogger, now = () => Date.now() }) {
		this.config = config;
		this.tracker = tracker;
		this.runner = runner;
		this.workspaceManager = workspaceManager;
		this.logger = logger;
		this.now = now;
		this.running = new Map();
		this.claimed = new Set();
		this.retryAttempts = new Map();
		this.events = [];
		this.agentTotals = { input_tokens: 0, output_tokens: 0, total_tokens: 0, seconds_running: 0 };
		this.codexTotals = this.agentTotals;
		this.rateLimits = null;
		this.lastError = null;
	}

	async startupCleanup() {
		try {
			const terminalIssues = await this.tracker.fetchIssuesByStates(this.config.tracker.terminal_states);
			for (const issue of terminalIssues) {
				this.workspaceManager.remove(issue);
				this.log("workspace_removed_for_terminal_issue", { issue_id: issue.id, issue_identifier: issue.identifier });
			}
		} catch (error) {
			this.log("startup_terminal_cleanup_failed", { error: error.message });
		}
	}

	async tick() {
		await this.reconcileRunning();
		const validation = validateDispatchConfig(this.config, { requireSecrets: true });
		if (validation.length > 0) {
			this.lastError = validation.join("; ");
			this.log("dispatch_validation_failed", { error: this.lastError });
			return { dispatched: 0, skipped: true, errors: validation };
		}
		runRepositorySync(this.config, this.logger);
		let candidates;
		try {
			candidates = await this.tracker.fetchCandidateIssues();
		} catch (error) {
			this.lastError = error.message;
			this.log("candidate_fetch_failed", { error: error.message });
			return { dispatched: 0, skipped: true, errors: [error.message] };
		}
		let dispatched = 0;
		let remainingGlobalSlots = this.availableGlobalSlots();
		const scheduledByState = new Map();
		for (const issue of sortCandidates(candidates)) {
			if (!this.isEligible(issue)) {
				continue;
			}
			if (remainingGlobalSlots <= 0 || this.availableSlotsFor(issue.state, scheduledByState) <= 0) {
				continue;
			}
			dispatched += 1;
			remainingGlobalSlots -= 1;
			scheduledByState.set(issue.state, (scheduledByState.get(issue.state) || 0) + 1);
			await this.dispatchIssue(issue);
		}
		return { dispatched, skipped: false, errors: [] };
	}

	isActiveState(state) {
		return this.config.tracker.active_states.includes(state);
	}

	isTerminalState(state) {
		return this.config.tracker.terminal_states.includes(state);
	}

	isEligible(issue) {
		if (!issue.id || !issue.identifier || !issue.title || !issue.state) {
			return false;
		}
		if (!this.isActiveState(issue.state) || this.isTerminalState(issue.state)) {
			return false;
		}
		if (this.running.has(issue.id) || this.claimed.has(issue.id)) {
			return false;
		}
		const activeBlockers = this.activeBlockers(issue);
		if (activeBlockers.length > 0) {
			return false;
		}
		return true;
	}

	activeBlockers(issue) {
		return (issue.blocked_by || []).filter((blocker) => !this.isTerminalState(blocker.state));
	}

	stackParentFor(issue) {
		const [blocker] = this.activeBlockers(issue);
		if (!blocker?.identifier) {
			return null;
		}
		return {
			issue: blocker,
			branch: branchNameForIssue(this.config, blocker.identifier)
		};
	}

	isStackParentReady(stackParent) {
		const runningParent = [...this.running.values()].some((entry) => entry.issue.id === stackParent.issue.id);
		return !runningParent && gitBranchExists(this.config.repository.root, stackParent.branch);
	}

	availableGlobalSlots() {
		return Math.max(this.config.agent.max_concurrent_agents - this.running.size, 0);
	}

	availableSlotsFor(state, scheduledByState = new Map()) {
		const globalAvailable = this.availableGlobalSlots();
		const perStateLimit = this.config.agent.max_concurrent_agents_by_state?.[state];
		if (!perStateLimit) {
			return globalAvailable;
		}
		const runningForState = [...this.running.values()].filter((entry) => entry.issue.state === state).length;
		const scheduledForState = scheduledByState.get(state) || 0;
		return Math.min(globalAvailable, Math.max(perStateLimit - runningForState - scheduledForState, 0));
	}

	async transitionIssueState(issue, transition, stateId) {
		if (!stateId || typeof this.tracker.updateIssueState !== "function") {
			return issue;
		}
		try {
			const updated = await this.tracker.updateIssueState(issue.id, stateId);
			this.log("linear_state_transitioned", {
				issue_id: issue.id,
				issue_identifier: issue.identifier,
				transition,
				state: updated.state
			});
			return { ...issue, ...updated, state: updated.state || issue.state };
		} catch (error) {
			this.log("linear_state_transition_failed", {
				issue_id: issue.id,
				issue_identifier: issue.identifier,
				transition,
				error: error.message
			});
			return issue;
		}
	}

	workpadMarker() {
		return this.config.tracker.workpad?.marker || DEFAULTS.tracker.workpad.marker;
	}

	workpadEnabled() {
		return this.config.tracker.workpad?.enabled !== false;
	}

	async updateWorkpad(runningEntry, status, note = "") {
		if (!this.workpadEnabled() || typeof this.tracker.ensureWorkpadComment !== "function") {
			return;
		}
		const body = renderWorkpadComment({
			marker: this.workpadMarker(),
			issue: runningEntry.issue,
			entry: runningEntry,
			status,
			note,
			generatedAt: new Date(this.now()).toISOString()
		});
		try {
			let comment;
			if (runningEntry.workpad_comment_id && typeof this.tracker.updateIssueComment === "function") {
				comment = await this.tracker.updateIssueComment(runningEntry.workpad_comment_id, body);
			} else {
				comment = await this.tracker.ensureWorkpadComment(runningEntry.issue.id, this.workpadMarker(), body);
			}
			runningEntry.workpad_comment_id = comment.id;
			runningEntry.issue.workpad_comment_id = comment.id;
			this.log("linear_workpad_updated", { issue_id: runningEntry.issue.id, issue_identifier: runningEntry.issue.identifier, comment_id: comment.id, status });
		} catch (error) {
			this.log("linear_workpad_update_failed", { issue_id: runningEntry.issue.id, issue_identifier: runningEntry.issue.identifier, status, error: error.message });
		}
	}

	async attachPromptComments(issue) {
		if (typeof this.tracker.fetchIssueComments !== "function") {
			return { ...issue, comments: [], recent_comments: formatPromptComments([]) };
		}
		try {
			const comments = await this.tracker.fetchIssueComments(issue.id);
			const promptComments = selectPromptComments(comments, this.workpadMarker());
			this.log("linear_prompt_comments_loaded", { issue_id: issue.id, issue_identifier: issue.identifier, count: promptComments.length });
			return {
				...issue,
				comments: promptComments,
				recent_comments: formatPromptComments(promptComments)
			};
		} catch (error) {
			this.log("linear_prompt_comments_failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: error.message });
			return {
				...issue,
				comments: [],
				recent_comments: `Unable to load Linear comments for this run: ${error.message}`
			};
		}
	}

	repoPathForWorkspace(workspace) {
		const candidate = path.join(workspace.path, "repo");
		if (fs.existsSync(path.join(candidate, ".git"))) {
			return candidate;
		}
		return null;
	}

	readGitHubFeedbackCutoff(repoPath) {
		return childProcess
			.execFileSync("git", ["log", "-1", "--format=%cI", "HEAD"], {
				cwd: repoPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"]
			})
			.trim();
	}

	fetchGitHubPullRequestFeedback(repoPath) {
		const pr = JSON.parse(
			childProcess.execFileSync("gh", ["pr", "view", "--json", "number,url,headRefName"], {
				cwd: repoPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"]
			})
		);
		const repo = JSON.parse(
			childProcess.execFileSync("gh", ["repo", "view", "--json", "owner,name"], {
				cwd: repoPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"]
			})
		);
		const query = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100) {
        nodes {
          body
          createdAt
          updatedAt
          url
          author { login }
        }
      }
      reviews(first: 100) {
        nodes {
          body
          submittedAt
          updatedAt
          state
          url
          author { login }
          comments(first: 100) {
            nodes {
              body
              createdAt
              updatedAt
              url
              path
              line
              author { login }
            }
          }
        }
      }
    }
  }
}`;
		const owner = repo.owner?.login || repo.owner?.name || repo.owner;
		const payload = JSON.parse(
			childProcess.execFileSync("gh", ["api", "graphql", "-f", `query=${query}`, "-F", `owner=${owner}`, "-F", `repo=${repo.name}`, "-F", `number=${pr.number}`], {
				cwd: repoPath,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "pipe"]
			})
		);
		return {
			pr,
			feedback: flattenGitHubFeedbackPayload(payload)
		};
	}

	attachGitHubPromptComments(issue, workspace) {
		const repoPath = this.repoPathForWorkspace(workspace);
		if (!repoPath) {
			return { ...issue, github_comments: [], recent_github_comments: formatGitHubFeedback([]) };
		}
		try {
			const cutoff = this.readGitHubFeedbackCutoff(repoPath);
			const { pr, feedback } = this.fetchGitHubPullRequestFeedback(repoPath);
			const promptComments = selectGitHubFeedbackSince(feedback, cutoff);
			this.log("github_prompt_comments_loaded", {
				issue_id: issue.id,
				issue_identifier: issue.identifier,
				pr: pr.number,
				cutoff,
				count: promptComments.length
			});
			return {
				...issue,
				github_comments: promptComments,
				recent_github_comments: formatGitHubFeedback(promptComments)
			};
		} catch (error) {
			this.log("github_prompt_comments_failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: error.message });
			return {
				...issue,
				github_comments: [],
				recent_github_comments: `Unable to load GitHub PR comments for this run: ${error.message}`
			};
		}
	}

	async dispatchIssue(issue, attempt = null) {
		this.claimed.add(issue.id);
		const stackParent = this.stackParentFor(issue);
		issue = await this.transitionIssueState(issue, "on_dispatch", this.config.tracker.state_transitions?.on_dispatch_state_id);
		if (stackParent) {
			issue = { ...issue, stack_parent: stackParent };
		}
		issue = await this.attachPromptComments(issue);
		const startedAt = this.now();
		const runningEntry = {
			issue,
			attempt,
			phase: "PreparingWorkspace",
			started_at_ms: startedAt,
			started_at: new Date(startedAt).toISOString(),
			last_agent_timestamp_ms: null,
			last_event: "started",
			last_message: "",
			turn_count: 0,
			session_id: null,
			tokens: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
			workspace: null,
			workpad_comment_id: null
		};
		this.running.set(issue.id, runningEntry);
		this.log("issue_dispatching", { issue_id: issue.id, issue_identifier: issue.identifier });
		try {
			await this.updateWorkpad(runningEntry, "Preparing workspace");
			runningEntry.workspace = this.workspaceManager.prepare(issue);
			issue = this.attachGitHubPromptComments(issue, runningEntry.workspace);
			runningEntry.issue = issue;
			runningEntry.phase = "BuildingPrompt";
			const prompt = renderPrompt(this.config.prompt_template, { issue, attempt });
			runningEntry.phase = "LaunchingAgentProcess";
			await this.updateWorkpad(runningEntry, "Launching agent");
			this.workspaceManager.runHook("before_run", runningEntry.workspace.path, this.workspaceManager.hookEnv(issue, runningEntry.workspace.path));
			const outcome = await this.runner.run({
				issue,
				workspacePath: runningEntry.workspace.path,
				prompt,
				attempt,
				onEvent: (event) => this.handleAgentEvent(issue.id, event)
			});
			runningEntry.phase = outcome.status;
			runningEntry.session_id = outcome.session_id || runningEntry.session_id;
			this.log("issue_run_completed", { issue_id: issue.id, issue_identifier: issue.identifier, status: outcome.status });
			await this.updateWorkpad(runningEntry, outcome.status, "Agent turn completed. Symphony scheduled a continuation check while the issue remains active.");
			this.scheduleRetry(issue, 1, "continuation check", 1000);
		} catch (error) {
			const status = error.status || "Failed";
			runningEntry.phase = status;
			this.log("issue_run_failed", { issue_id: issue.id, issue_identifier: issue.identifier, status, error: error.message });
			await this.updateWorkpad(runningEntry, status, error.message);
			this.scheduleRetry(issue, (attempt || 0) + 1, error.message);
		} finally {
			try {
				if (runningEntry.workspace?.path) {
					this.workspaceManager.runHook("after_run", runningEntry.workspace.path, this.workspaceManager.hookEnv(issue, runningEntry.workspace.path));
				}
			} catch (error) {
				this.log("hook_failed_ignored", { hook: "after_run", issue_id: issue.id, issue_identifier: issue.identifier, error: error.message });
			}
			this.agentTotals.seconds_running += (this.now() - startedAt) / 1000;
			this.running.delete(issue.id);
		}
	}

	scheduleRetry(issue, attempt, error, fixedDelayMs = null) {
		const existing = this.retryAttempts.get(issue.id);
		if (existing?.timer) {
			clearTimeout(existing.timer);
		}
		const delay = fixedDelayMs == null ? Math.min(10000 * 2 ** Math.max(attempt - 1, 0), this.config.agent.max_retry_backoff_ms) : fixedDelayMs;
		const dueAtMs = this.now() + delay;
		const retry = {
			attempt,
			issue_id: issue.id,
			identifier: issue.identifier,
			error,
			due_at_ms: dueAtMs,
			due_at: new Date(dueAtMs).toISOString(),
			timer: null
		};
		retry.timer = setTimeout(() => {
			this.handleRetry(issue.id).catch((retryError) => {
				this.log("retry_failed", { issue_id: issue.id, issue_identifier: issue.identifier, error: retryError.message });
			});
		}, delay);
		if (typeof retry.timer.unref === "function") {
			retry.timer.unref();
		}
		this.retryAttempts.set(issue.id, retry);
		this.log("retry_scheduled", { issue_id: issue.id, issue_identifier: issue.identifier, attempt, error, due_at: retry.due_at });
		return retry;
	}

	async handleRetry(issueId) {
		const retry = this.retryAttempts.get(issueId);
		if (!retry) {
			return;
		}
		let candidates;
		try {
			candidates = await this.tracker.fetchCandidateIssues();
		} catch (error) {
			this.scheduleRetry({ id: retry.issue_id, identifier: retry.identifier, title: retry.identifier, state: "unknown" }, retry.attempt + 1, error.message);
			return;
		}
		const issue = candidates.find((candidate) => candidate.id === issueId);
		if (!issue || !this.isActiveState(issue.state)) {
			this.retryAttempts.delete(issueId);
			this.claimed.delete(issueId);
			this.log("retry_released", { issue_id: retry.issue_id, issue_identifier: retry.identifier });
			return;
		}
		this.claimed.delete(issueId);
		if (!this.isEligible(issue) || this.availableSlotsFor(issue.state) <= 0) {
			this.claimed.add(issueId);
			this.scheduleRetry(issue, retry.attempt + 1, "no available orchestrator slots");
			return;
		}
		this.retryAttempts.delete(issueId);
		await this.dispatchIssue(issue, retry.attempt);
	}

	async reconcileRunning() {
		this.detectStalls();
		const ids = [...this.running.keys()];
		if (ids.length === 0) {
			return;
		}
		let states;
		try {
			states = await this.tracker.fetchIssueStatesByIds(ids);
		} catch (error) {
			this.log("running_state_refresh_failed", { error: error.message });
			return;
		}
		for (const [issueId, entry] of this.running.entries()) {
			const latest = states.get(issueId);
			if (!latest) {
				continue;
			}
			if (this.isTerminalState(latest.state)) {
				this.running.delete(issueId);
				this.claimed.delete(issueId);
				this.workspaceManager.remove(latest);
				this.log("running_issue_terminal_released", { issue_id: latest.id, issue_identifier: latest.identifier });
				continue;
			}
			if (!this.isActiveState(latest.state)) {
				this.running.delete(issueId);
				this.claimed.delete(issueId);
				this.log("running_issue_non_active_released", { issue_id: latest.id, issue_identifier: latest.identifier });
				continue;
			}
			entry.issue = latest;
		}
	}

	detectStalls() {
		const stallTimeout = (this.config.agent_runtime || this.config.codex || DEFAULTS.agent_runtime).stall_timeout_ms;
		if (!stallTimeout || stallTimeout <= 0) {
			return;
		}
		for (const [issueId, entry] of this.running.entries()) {
			const basis = entry.last_agent_timestamp_ms || entry.started_at_ms;
			if (this.now() - basis > stallTimeout) {
				this.running.delete(issueId);
				this.scheduleRetry(entry.issue, (entry.attempt || 0) + 1, "stalled");
				this.log("running_issue_stalled", { issue_id: entry.issue.id, issue_identifier: entry.issue.identifier });
			}
		}
	}

	handleAgentEvent(issueId, event) {
		const entry = this.running.get(issueId);
		const timestampMs = Date.parse(event.timestamp || new Date().toISOString()) || this.now();
		if (entry) {
			entry.last_agent_timestamp_ms = timestampMs;
			entry.last_event = event.event;
			entry.last_message = event.message || "";
			entry.session_id = event.session_id || entry.session_id;
			if (event.event === "turn_completed") {
				entry.turn_count += 1;
			}
			if (event.usage) {
				const nextTokens = extractTokenUsage(event.usage);
				this.addTokenTotals({
					input_tokens: nextTokens.input_tokens - entry.tokens.input_tokens,
					output_tokens: nextTokens.output_tokens - entry.tokens.output_tokens,
					total_tokens: nextTokens.total_tokens - entry.tokens.total_tokens
				});
				entry.tokens = nextTokens;
			} else if (event.usage_delta) {
				const deltaTokens = extractTokenUsage(event.usage_delta);
				entry.tokens = {
					input_tokens: entry.tokens.input_tokens + deltaTokens.input_tokens,
					output_tokens: entry.tokens.output_tokens + deltaTokens.output_tokens,
					total_tokens: entry.tokens.total_tokens + deltaTokens.total_tokens
				};
				this.addTokenTotals(deltaTokens);
			}
		}
		if (event.rate_limits) {
			this.rateLimits = event.rate_limits;
		}
		this.events.push({ at: new Date(timestampMs).toISOString(), issue_id: issueId, ...event });
		this.events = this.events.slice(-100);
	}

	addTokenTotals(tokens) {
		this.agentTotals.input_tokens += tokens.input_tokens;
		this.agentTotals.output_tokens += tokens.output_tokens;
		this.agentTotals.total_tokens += tokens.total_tokens;
	}

	log(event, fields = {}) {
		this.logger(event, fields);
	}

	snapshot() {
		const now = this.now();
		const running = [...this.running.values()].map((entry) => ({
			issue_id: entry.issue.id,
			issue_identifier: entry.issue.identifier,
			state: entry.issue.state,
			lifecycle: classifyLifecycleState(this.config, entry.issue.state, "running"),
			session_id: entry.session_id,
			turn_count: entry.turn_count,
			last_event: entry.last_event,
			last_message: entry.last_message,
			started_at: entry.started_at,
			last_event_at: entry.last_agent_timestamp_ms ? new Date(entry.last_agent_timestamp_ms).toISOString() : null,
			tokens: entry.tokens,
			workspace: entry.workspace
		}));
		const retrying = [...this.retryAttempts.values()].map((retry) => ({
			issue_id: retry.issue_id,
			issue_identifier: retry.identifier,
			attempt: retry.attempt,
			lifecycle: classifyLifecycleState(this.config, null, "retrying"),
			due_at: retry.due_at,
			error: retry.error
		}));
		const activeSeconds = [...this.running.values()].reduce((total, entry) => total + (now - entry.started_at_ms) / 1000, 0);
		return {
			generated_at: new Date(now).toISOString(),
			counts: { running: running.length, retrying: retrying.length },
			lifecycle_counts: countBy([...running, ...retrying], "lifecycle"),
			running,
			retrying,
			agent_runtime: {
				provider: (this.config.agent_runtime || this.config.codex || DEFAULTS.agent_runtime).provider || "codex",
				event_format: (this.config.agent_runtime || this.config.codex || DEFAULTS.agent_runtime).event_format || "codex-json"
			},
			agent_totals: { ...this.agentTotals, seconds_running: this.agentTotals.seconds_running + activeSeconds },
			codex_totals: { ...this.agentTotals, seconds_running: this.agentTotals.seconds_running + activeSeconds },
			rate_limits: this.rateLimits,
			last_error: this.lastError
		};
	}

	issueSnapshot(issueIdentifier) {
		const running = [...this.running.values()].find((entry) => entry.issue.identifier === issueIdentifier);
		const retry = [...this.retryAttempts.values()].find((entry) => entry.identifier === issueIdentifier);
		const recentEvents = this.events.filter((event) => {
			const runningIssueId = running?.issue.id;
			const retryIssueId = retry?.issue_id;
			return event.issue_id === runningIssueId || event.issue_id === retryIssueId;
		});
		if (!running && !retry && recentEvents.length === 0) {
			return null;
		}
		return {
			issue_identifier: issueIdentifier,
			issue_id: running?.issue.id || retry?.issue_id || recentEvents[0]?.issue_id || null,
			status: running ? "running" : retry ? "retrying" : "observed",
			lifecycle: running ? classifyLifecycleState(this.config, running.issue.state, "running") : retry ? "rework" : "observed",
			workspace: running?.workspace || null,
			attempts: {
				current_retry_attempt: retry?.attempt || null
			},
			running: running
				? {
						session_id: running.session_id,
						turn_count: running.turn_count,
						state: running.issue.state,
						started_at: running.started_at,
						last_event: running.last_event,
						last_message: running.last_message,
						last_event_at: running.last_agent_timestamp_ms ? new Date(running.last_agent_timestamp_ms).toISOString() : null,
						tokens: running.tokens
					}
				: null,
			retry: retry
				? {
						attempt: retry.attempt,
						due_at: retry.due_at,
						error: retry.error
					}
				: null,
			recent_events: recentEvents,
			last_error: this.lastError,
			tracked: {}
		};
	}
}

function extractTokenUsage(usage) {
	const tokenUsage = usage?.total_token_usage || usage?.last_token_usage || usage || {};
	const input = tokenUsage.input_tokens ?? tokenUsage.prompt_tokens ?? 0;
	const output = tokenUsage.output_tokens ?? tokenUsage.completion_tokens ?? 0;
	return {
		input_tokens: Number(input) || 0,
		output_tokens: Number(output) || 0,
		total_tokens: Number(tokenUsage.total_tokens ?? input + output) || 0
	};
}

function countBy(items, key) {
	return items.reduce((counts, item) => {
		const value = item[key] || "unknown";
		counts[value] = (counts[value] || 0) + 1;
		return counts;
	}, {});
}

function renderWorkpadComment({ marker, issue, entry, status, note = "", generatedAt }) {
	const workspacePath = entry.workspace?.path || "not created yet";
	const tokens = entry.tokens || { input_tokens: 0, output_tokens: 0, total_tokens: 0 };
	const attemptText = entry.attempt == null ? "initial" : String(entry.attempt);
	return `${marker}
## Symphony Workpad

### Status
- Issue: ${issue.identifier} - ${issue.title}
- Linear state: ${issue.state}
- Symphony status: ${status}
- Attempt: ${attemptText}
- Workspace: \`${workspacePath}\`
- Session: ${entry.session_id || "not started"}
- Last event: ${entry.last_event || "none"}
- Updated: ${generatedAt}

### Plan
- [ ] Follow the target repository workflow contract.
- [ ] Keep implementation scoped to this ticket.
- [ ] Open or update a ready-for-review PR.
- [ ] Stop before merge.

### Acceptance Criteria
- [ ] Ticket acceptance criteria are satisfied.
- [ ] PR is linked or discoverable from the branch.
- [ ] Review comments are addressed or explicitly pushed back.

### Validation
- [ ] Relevant local checks are run.
- [ ] CI/review automation is checked before handoff.

### Notes
- Tokens observed: ${tokens.total_tokens} total (${tokens.input_tokens} input, ${tokens.output_tokens} output).
${note ? `- Latest note: ${note}` : "- Latest note: none"}
`;
}

function renderDashboard(snapshot) {
	const generatedAtMs = Date.parse(snapshot.generated_at) || Date.now();
	const formatNumber = (value) => Math.round(Number(value) || 0).toLocaleString();
	const formatDuration = (seconds) => {
		const total = Math.max(0, Math.round(Number(seconds) || 0));
		const hours = Math.floor(total / 3600);
		const minutes = Math.floor((total % 3600) / 60);
		const remainingSeconds = total % 60;
		if (hours > 0) return `${hours}h ${minutes}m ${remainingSeconds}s`;
		if (minutes > 0) return `${minutes}m ${remainingSeconds}s`;
		return `${remainingSeconds}s`;
	};
	const ageFor = (isoTimestamp) => {
		const startedAtMs = Date.parse(isoTimestamp || "");
		if (!startedAtMs) return "n/a";
		return formatDuration((generatedAtMs - startedAtMs) / 1000);
	};
	const truncate = (value, length) => {
		const text = String(value || "");
		return text.length <= length ? text : `${text.slice(0, Math.max(0, length - 1))}...`;
	};
	const shortSession = (value) => {
		const text = String(value || "pending");
		return text.length <= 12 ? text : `${text.slice(0, 6)}...${text.slice(-4)}`;
	};
	const throughput = snapshot.codex_totals.seconds_running > 0 ? (snapshot.codex_totals.total_tokens || 0) / snapshot.codex_totals.seconds_running : 0;
	const lifecycleCounts = Object.entries(snapshot.lifecycle_counts || {})
		.map(([key, value]) => `${key} ${value}`)
		.join(" / ");
	const rateLimits = snapshot.rate_limits ? JSON.stringify(snapshot.rate_limits) : "n/a";
	const runningRows = snapshot.running
		.map(
			(issue) => `<tr>
<td><span class="bullet"></span><a href="/api/v1/${encodeURIComponent(issue.issue_identifier)}">${escapeHtml(issue.issue_identifier)}</a></td>
<td>${escapeHtml(issue.state || "unknown")}</td>
<td>${escapeHtml(issue.lifecycle || "observed")}</td>
<td>${escapeHtml(ageFor(issue.started_at))} / ${escapeHtml(issue.turn_count ?? 0)}</td>
<td class="num">${formatNumber(issue.tokens?.total_tokens || 0)}</td>
<td title="${escapeHtml(String(issue.session_id || "pending"))}">${escapeHtml(shortSession(issue.session_id))}</td>
<td title="${escapeHtml(issue.last_message || issue.last_event || "")}">${escapeHtml(truncate(issue.last_message || issue.last_event || "", 62))}</td>
<td title="${escapeHtml(issue.workspace?.path || "")}">${escapeHtml(truncate(issue.workspace?.path || "", 42))}</td>
</tr>`
		)
		.join("");
	const retryRows = snapshot.retrying
		.map(
			(issue) => `<tr>
<td><span class="bullet warn-dot"></span>${escapeHtml(issue.issue_identifier)}</td>
<td>${escapeHtml(issue.lifecycle)}</td>
<td class="num">${escapeHtml(issue.attempt)}</td>
<td>${escapeHtml(issue.due_at)}</td>
<td colspan="4" title="${escapeHtml(issue.error || "")}">${escapeHtml(truncate(issue.error || "", 78))}</td>
</tr>`
		)
		.join("");
	return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Symphony Agent</title>
<style>
:root {
	color-scheme: dark;
	font-family: "Berkeley Mono", "SFMono-Regular", Consolas, "Liberation Mono", Menlo, monospace;
	--bg: #252932;
	--panel: #20242c;
	--line: #87909b;
	--muted: #7d8591;
	--text: #e7ecf2;
	--blue: #a8c7e8;
	--gold: #f5d36c;
	--green: #9ad9b5;
	--red: #f2a6a6;
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font-size: 13px; letter-spacing: 0; }
main { width: 100%; max-width: 1280px; margin: 0; padding: 12px 10px 18px; }
.console { min-height: calc(100vh - 24px); border-left: 1px solid var(--text); border-bottom: 1px solid var(--text); padding: 0 0 0 8px; }
.title { display: inline-block; padding: 0 8px; margin: -1px 0 8px -1px; color: #ffffff; font-weight: 700; text-transform: uppercase; letter-spacing: .08em; background: var(--bg); }
.status-grid { display: grid; grid-template-columns: max-content 1fr; column-gap: 8px; row-gap: 2px; max-width: 980px; }
.label { color: #ffffff; font-weight: 700; }
.value { color: var(--blue); overflow-wrap: anywhere; }
.value strong { color: var(--gold); font-weight: 700; }
.ok { color: var(--green); }
.warn { color: var(--red); }
.muted { color: var(--muted); }
.section { margin-top: 18px; }
.section-title { display: flex; align-items: center; gap: 8px; margin: 0 0 10px; color: #ffffff; font-weight: 700; }
.section-title:before { content: ""; display: inline-block; width: 10px; height: 1px; background: #ffffff; }
.table-wrap { overflow-x: auto; }
table { width: 100%; min-width: 1040px; border-collapse: collapse; table-layout: fixed; }
th, td { padding: 4px 8px; text-align: left; vertical-align: top; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
th { color: var(--muted); font-weight: 400; text-transform: uppercase; letter-spacing: .08em; border-bottom: 1px solid var(--line); }
td { color: var(--blue); }
td.num { color: var(--gold); text-align: right; }
th:nth-child(1), td:nth-child(1) { width: 108px; }
th:nth-child(2), td:nth-child(2) { width: 126px; }
th:nth-child(3), td:nth-child(3) { width: 116px; }
th:nth-child(4), td:nth-child(4) { width: 92px; }
th:nth-child(5), td:nth-child(5) { width: 112px; }
th:nth-child(6), td:nth-child(6) { width: 128px; }
th:nth-child(7), td:nth-child(7) { width: 360px; }
th:nth-child(8), td:nth-child(8) { width: 300px; }
a { color: var(--blue); text-decoration: none; }
a:hover { color: #ffffff; text-decoration: underline; }
.bullet { display: inline-block; width: 5px; height: 5px; margin-right: 8px; border-radius: 50%; background: var(--blue); vertical-align: 1px; }
.warn-dot { background: var(--red); }
.empty { padding: 16px 8px; color: var(--muted); }
details { margin-top: 18px; }
summary { cursor: pointer; color: var(--muted); }
pre { max-height: 420px; overflow: auto; margin: 10px 0 0; padding: 12px; background: var(--panel); border: 1px solid #3b414c; color: var(--blue); white-space: pre-wrap; }
@media (max-width: 720px) {
	body { font-size: 12px; }
	main { padding: 8px; }
	.status-grid { grid-template-columns: 1fr; row-gap: 4px; }
	.value { margin-bottom: 6px; }
}
</style>
</head>
<body>
<main>
<div class="console">
<div class="title">Symphony Status</div>
<div class="status-grid">
<div class="label">Agents:</div><div class="value"><strong>${snapshot.counts.running}</strong> running / <strong>${snapshot.counts.running + snapshot.counts.retrying}</strong> tracked</div>
<div class="label">Throughput:</div><div class="value"><strong>${throughput.toLocaleString(undefined, { maximumFractionDigits: 1 })}</strong> tps</div>
<div class="label">Runtime:</div><div class="value">${escapeHtml(formatDuration(snapshot.codex_totals.seconds_running || 0))}</div>
<div class="label">Tokens:</div><div class="value">in <strong>${formatNumber(snapshot.codex_totals.input_tokens || 0)}</strong> | out <strong>${formatNumber(snapshot.codex_totals.output_tokens || 0)}</strong> | total <strong>${formatNumber(snapshot.codex_totals.total_tokens || 0)}</strong></div>
<div class="label">Rate limits:</div><div class="value">${escapeHtml(rateLimits)}</div>
<div class="label">Lifecycle:</div><div class="value">${escapeHtml(lifecycleCounts || "n/a")}</div>
<div class="label">Last error:</div><div class="value ${snapshot.last_error ? "warn" : "ok"}">${escapeHtml(snapshot.last_error || "none")}</div>
<div class="label">Generated:</div><div class="value">${escapeHtml(snapshot.generated_at)} | next refresh in 10s</div>
</div>

<section class="section">
<div class="section-title">Running</div>
<div class="table-wrap">
<table><thead><tr><th>ID</th><th>Stage</th><th>Lifecycle</th><th>Age / Turn</th><th>Tokens</th><th>Session</th><th>Event</th><th>Workspace</th></tr></thead><tbody>${runningRows || '<tr><td colspan="8" class="empty">No running agents</td></tr>'}</tbody></table>
</div>
</section>

<section class="section">
<div class="section-title">Backoff Queue</div>
<div class="table-wrap">
<table><thead><tr><th>ID</th><th>Lifecycle</th><th>Attempt</th><th>Due</th><th colspan="4">Error</th></tr></thead><tbody>${retryRows || '<tr><td colspan="8" class="empty">No queued retries</td></tr>'}</tbody></table>
</div>
</section>

<details>
<summary>Raw JSON state</summary>
<pre>${escapeHtml(JSON.stringify(snapshot, null, 2))}</pre>
</details>
</div>
</main>
</body>
</html>`;
}

function estimateTokenUsageFromText(text) {
	const tokenCount = Math.ceil(String(text || "").length / 4);
	return { input_tokens: tokenCount, output_tokens: 0, total_tokens: tokenCount };
}

function estimateOutputTokenUsageFromText(text) {
	const tokenCount = Math.ceil(String(text || "").length / 4);
	return { input_tokens: 0, output_tokens: tokenCount, total_tokens: tokenCount };
}

function parseCodexJsonEvent(line, { sessionId, streamName }) {
	let parsed;
	try {
		parsed = JSON.parse(line);
	} catch (_error) {
		return null;
	}
	const payload = parsed.payload || parsed;
	const eventType = payload.type || parsed.type;
	if (eventType !== "token_count") {
		const item = payload.item || parsed.item || {};
		const text = payload.message || payload.text || item.text || item.aggregated_output || null;
		if (!text) {
			return null;
		}
		const event = { event: "agent_output", session_id: sessionId, stream: streamName, timestamp: parsed.timestamp || new Date().toISOString(), text };
		if (eventType === "item.completed") {
			event.usage_delta = estimateTokenUsageFromText(text);
		}
		return event;
	}
	return {
		event: "token_count",
		session_id: sessionId,
		stream: streamName,
		timestamp: parsed.timestamp || new Date().toISOString(),
		usage: payload.info?.total_token_usage || payload.info?.last_token_usage || payload.usage || payload.info || {},
		rate_limits: payload.rate_limits || null
	};
}

function defaultLogger(event, fields = {}) {
	const fieldText = Object.entries(fields)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
	process.stderr.write(`event=${event}${fieldText ? ` ${fieldText}` : ""}\n`);
}

function createRuntime(config) {
	const tracker = new LinearTracker(config);
	const workspaceManager = new WorkspaceManager(config, defaultLogger);
	const runner = new AgentRunner(config, defaultLogger);
	return new SymphonyOrchestrator({ config, tracker, workspaceManager, runner });
}

function applyRuntimeConfig(runtime, config) {
	runtime.config = config;
	runtime.tracker.config = config;
	runtime.runner.config = config;
	runtime.workspaceManager.config = config;
	runtime.workspaceManager.root = path.resolve(config.workspace.root);
}

function writeJson(value) {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

async function main(argv = process.argv.slice(2)) {
	const [command = "validate", ...rest] = argv;
	const args = parseArgs(rest);
	const workflowPath = args.workflow || defaultWorkflowPath;
	const config = loadConfig({ workflowPath });

	if (command === "validate") {
		const failures = validateDispatchConfig(config, { requireSecrets: Boolean(args["require-secrets"]) });
		if (failures.length > 0) {
			console.error("Symphony validation failed:");
			for (const failure of failures) {
				console.error(`- ${failure}`);
			}
			process.exit(1);
		}
		console.log("Symphony validation passed.");
		return;
	}

	if (command === "config") {
		const redacted = JSON.parse(JSON.stringify(config));
		if (redacted.tracker?.api_key) {
			redacted.tracker.api_key = "[redacted]";
		}
		writeJson(redacted);
		return;
	}

	if (command === "once") {
		const failures = validateDispatchConfig(config, { requireSecrets: true });
		if (failures.length > 0) {
			throw new Error(`dispatch validation failed: ${failures.join("; ")}`);
		}
		const runtime = createRuntime(config);
		await runtime.startupCleanup();
		const result = await runtime.tick();
		writeJson({ result, state: runtime.snapshot() });
		return;
	}

	if (command === "serve") {
		const failures = validateDispatchConfig(config, { requireSecrets: true });
		if (failures.length > 0) {
			throw new Error(`dispatch validation failed: ${failures.join("; ")}`);
		}
		const runtime = createRuntime(config);
		await runtime.startupCleanup();
		fs.watchFile(workflowPath, { interval: 1000 }, () => {
			try {
				const previousIntervalMs = runtime.config.polling.interval_ms;
				const nextConfig = loadConfig({ workflowPath });
				const reloadFailures = validateDispatchConfig(nextConfig, { requireSecrets: true });
				if (reloadFailures.length > 0) {
					runtime.log("workflow_reload_rejected", { error: reloadFailures.join("; ") });
					return;
				}
				applyRuntimeConfig(runtime, nextConfig);
				runtime.log("workflow_reloaded", { workflow_path: workflowPath });
				if (nextConfig.polling.interval_ms !== previousIntervalMs) {
					schedulePollLoop({ runImmediately: false });
				}
			} catch (error) {
				runtime.log("workflow_reload_failed", { error: error.message });
			}
		});
		const runPollTick = () => {
			runtime.tick().catch((error) => runtime.log("poll_tick_failed", { error: error.message }));
		};
		let pollTimer = null;
		const schedulePollLoop = ({ runImmediately } = { runImmediately: true }) => {
			if (pollTimer) {
				clearInterval(pollTimer);
			}
			if (runImmediately) {
				runPollTick();
			}
			pollTimer = setInterval(runPollTick, runtime.config.polling.interval_ms);
			if (typeof pollTimer.unref === "function") {
				pollTimer.unref();
			}
		};
		const port = Number(args.port || config.server?.port || 0);
		const server = http.createServer((request, response) => {
			const url = new URL(request.url || "/", "http://127.0.0.1");
			if (url.pathname === "/api/v1/state" && request.method !== "GET") {
				response.statusCode = 405;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ error: { code: "method_not_allowed", message: "GET required" } }));
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/v1/state") {
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify(runtime.snapshot(), null, 2));
				return;
			}
			if (url.pathname === "/api/v1/refresh" && request.method !== "POST") {
				response.statusCode = 405;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ error: { code: "method_not_allowed", message: "POST required" } }));
				return;
			}
			if (request.method === "POST" && url.pathname === "/api/v1/refresh") {
				runtime.tick().catch((error) => runtime.log("manual_refresh_failed", { error: error.message }));
				response.statusCode = 202;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ queued: true, requested_at: new Date().toISOString(), operations: ["poll", "reconcile"] }));
				return;
			}
			const issueMatch = url.pathname.match(/^\/api\/v1\/([^/]+)$/);
			if (issueMatch && request.method !== "GET") {
				response.statusCode = 405;
				response.setHeader("content-type", "application/json");
				response.end(JSON.stringify({ error: { code: "method_not_allowed", message: "GET required" } }));
				return;
			}
			if (issueMatch) {
				const issue = runtime.issueSnapshot(decodeURIComponent(issueMatch[1]));
				response.setHeader("content-type", "application/json");
				if (!issue) {
					response.statusCode = 404;
					response.end(JSON.stringify({ error: { code: "issue_not_found", message: "issue not found" } }));
					return;
				}
				response.end(JSON.stringify(issue, null, 2));
				return;
			}
			if (request.method === "GET" && url.pathname === "/") {
				response.setHeader("content-type", "text/html; charset=utf-8");
				response.end(renderDashboard(runtime.snapshot()));
				return;
			}
			response.statusCode = 404;
			response.setHeader("content-type", "application/json");
			response.end(JSON.stringify({ error: { code: "not_found", message: "not found" } }));
		});
		server.listen(port, "127.0.0.1", () => {
			const address = server.address();
			console.log(`Symphony server listening on http://127.0.0.1:${address.port}`);
			schedulePollLoop();
		});
		const shutdown = (signal) => {
			runtime.log("server_shutdown", { signal });
			if (pollTimer) {
				clearInterval(pollTimer);
			}
			fs.unwatchFile(workflowPath);
			runtime.runner.terminateAll(signal === "SIGINT" ? "SIGINT" : "SIGTERM");
			server.close(() => process.exit(0));
			setTimeout(() => process.exit(0), 5000).unref();
		};
		process.once("SIGINT", () => shutdown("SIGINT"));
		process.once("SIGTERM", () => shutdown("SIGTERM"));
		return;
	}

	console.error("Usage: symphony.js <validate|config|once|serve>");
	process.exit(1);
}

function escapeHtml(value) {
	return String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

if (require.main === module) {
	main().catch((error) => {
		console.error(`Symphony failed: ${error.message}`);
		process.exit(1);
	});
}

module.exports = {
	AgentRunner,
	LinearTracker,
	SymphonyOrchestrator,
	WorkspaceManager,
	createAgentAdapter,
	extractTokenUsage,
	loadConfig,
	loadLocalEnv,
	normalizeIssue,
	parseEnvFile,
	parseFrontMatterYaml,
	parseCodexJsonEvent,
	selectPromptComments,
	formatPromptComments,
	flattenGitHubFeedbackPayload,
	selectGitHubFeedbackSince,
	formatGitHubFeedback,
	renderWorkpadComment,
	renderDashboard,
	classifyLifecycleState,
	estimateTokenUsageFromText,
	readWorkflowFile,
	renderPrompt,
	runRepositorySync,
	sortCandidates,
	validateDispatchConfig
};
