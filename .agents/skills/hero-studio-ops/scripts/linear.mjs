#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const API_URL = "https://api.linear.app/graphql";
const TEAM_KEY = "HERO";

function usage() {
  console.log(`HERO Studio Linear helper

Read commands:
  doctor
  list [--state NAME] [--label NAME] [--limit N]
  issue HERO-123

Guarded write commands (preview by default):
  create --file issue.json [--apply]
  transition HERO-123 "In Progress" [--apply]
  add-labels HERO-123 "Bug,Area / Render" [--apply]
  comment HERO-123 --file comment.md [--apply]
`);
}

function option(args, name) {
  const index = args.indexOf(name);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function positional(args) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--apply") continue;
    if (args[index].startsWith("--")) {
      index += 1;
      continue;
    }
    values.push(args[index]);
  }
  return values;
}

function decodeEnvValue(raw) {
  const value = raw.trim();
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      return value.slice(1, -1);
    }
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function dotenvCredential(path) {
  if (!existsSync(path)) return null;
  const wanted = ["LINEAR_API_KEY", "linear_api"];
  const lines = readFileSync(path, "utf8").split(/\r?\n/);
  for (const name of wanted) {
    const pattern = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=(.*)$`);
    for (const line of lines) {
      const match = line.match(pattern);
      if (!match) continue;
      const value = decodeEnvValue(match[1]);
      if (value) return { value, source: `dotenv:${name}` };
    }
  }
  return null;
}

function worktreeRoots() {
  const roots = [];
  try {
    roots.push(execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim());
  } catch {
    // The process environment and Keychain still work outside a Git checkout.
  }
  try {
    const listing = execFileSync("git", ["worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    for (const line of listing.split(/\r?\n/)) {
      if (line.startsWith("worktree ")) roots.push(line.slice("worktree ".length));
    }
  } catch {
    // No worktree metadata is available.
  }
  roots.push(process.cwd());
  return [...new Set(roots.filter(Boolean).map((root) => resolve(root)))];
}

function resolveCredential() {
  for (const name of ["LINEAR_API_KEY", "linear_api"]) {
    if (process.env[name]) return { value: process.env[name], source: `environment:${name}` };
  }
  for (const root of worktreeRoots()) {
    const credential = dotenvCredential(resolve(root, ".env"));
    if (credential) return credential;
  }
  if (process.platform === "darwin") {
    try {
      const value = execFileSync(
        "security",
        ["find-generic-password", "-w", "-s", "heroai-linear-api-key"],
        { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
      ).trim();
      if (value) return { value, source: "macOS-keychain:heroai-linear-api-key" };
    } catch {
      // Report one consolidated credential error below.
    }
  }
  throw new Error(
    "Linear credential not found. Set LINEAR_API_KEY, add LINEAR_API_KEY/linear_api to a worktree .env, or use Keychain service heroai-linear-api-key.",
  );
}

async function graphql(credential, query, variables = {}) {
  const response = await fetch(API_URL, {
    method: "POST",
    headers: {
      Authorization: credential.value,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ query, variables }),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    throw new Error(`Linear returned non-JSON HTTP ${response.status}`);
  }
  if (!response.ok || body.errors?.length) {
    const messages = body.errors?.map((error) => error.message).join("; ") || `HTTP ${response.status}`;
    throw new Error(`Linear API: ${messages}`);
  }
  return body.data;
}

async function heroTeam(credential) {
  const data = await graphql(
    credential,
    `query HeroTeam {
      teams(filter: { key: { eq: "HERO" } }, first: 5) {
        nodes { id name key private triageEnabled cyclesEnabled cycleDuration timezone }
      }
    }`,
  );
  if (data.teams.nodes.length !== 1) {
    throw new Error(`Expected one ${TEAM_KEY} team, found ${data.teams.nodes.length}`);
  }
  return data.teams.nodes[0];
}

async function teamContext(credential) {
  const team = await heroTeam(credential);
  const data = await graphql(
    credential,
    `query TeamContext($id: String!) {
      team(id: $id) {
        states { nodes { id name type position } }
        labels(first: 100) { nodes { id name isGroup parent { id name } } }
      }
    }`,
    { id: team.id },
  );
  return { team, states: data.team.states.nodes, labels: data.team.labels.nodes };
}

async function issueByIdentifier(credential, identifier) {
  const data = await graphql(
    credential,
    `query HeroIssue($id: String!) {
      issue(id: $id) {
        id identifier title description priority url createdAt updatedAt
        team { id key name }
        state { id name type }
        assignee { id name }
        project { id name url }
        labels { nodes { id name isGroup parent { id name } } }
        comments(first: 50) { nodes { id body createdAt user { name } } }
      }
    }`,
    { id: identifier },
  );
  if (!data.issue || data.issue.team?.key !== TEAM_KEY) {
    throw new Error(`${identifier} is not an issue in team ${TEAM_KEY}`);
  }
  return data.issue;
}

function labelDisplay(label) {
  return label.parent ? `${label.parent.name} / ${label.name}` : label.name;
}

function normalize(value) {
  return value.trim().toLocaleLowerCase("en-US").replace(/\s*\/\s*/g, "/");
}

function resolveState(states, requested) {
  const matches = states.filter((state) => normalize(state.name) === normalize(requested));
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous state: ${requested}`);
  return matches[0];
}

function resolveLabels(labels, requested) {
  return requested.map((name) => {
    const normalized = normalize(name);
    const matches = labels.filter((label) => {
      if (label.isGroup) return false;
      return normalize(label.name) === normalized || normalize(labelDisplay(label)) === normalized;
    });
    if (matches.length !== 1) throw new Error(`Unknown or ambiguous label: ${name}`);
    return matches[0];
  });
}

async function currentViewer(credential) {
  const data = await graphql(credential, "query Viewer { viewer { id name organization { name urlKey } } }");
  return data.viewer;
}

async function exactProject(credential, requested) {
  const data = await graphql(
    credential,
    "query Projects { projects(first: 100) { nodes { id name url } } }",
  );
  const matches = data.projects.nodes.filter((project) => normalize(project.name) === normalize(requested));
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous project: ${requested}`);
  return matches[0];
}

function print(value) {
  console.log(JSON.stringify(value, null, 2));
}

async function doctor(credential) {
  const [viewer, team] = await Promise.all([currentViewer(credential), heroTeam(credential)]);
  print({
    authenticated: true,
    credentialSource: credential.source,
    organization: viewer.organization.name,
    team,
  });
}

async function listIssues(credential, args) {
  const team = await heroTeam(credential);
  const stateFilter = option(args, "--state");
  const labelFilter = option(args, "--label");
  const requestedLimit = Number(option(args, "--limit") || 50);
  if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 100) {
    throw new Error("--limit must be an integer from 1 to 100");
  }
  const data = await graphql(
    credential,
    `query TeamIssues($id: String!) {
      team(id: $id) {
        issues(first: 100) {
          nodes {
            identifier title priority url createdAt updatedAt
            state { name }
            assignee { name }
            labels { nodes { name parent { name } } }
          }
        }
      }
    }`,
    { id: team.id },
  );
  const issues = data.team.issues.nodes
    .filter((issue) => !stateFilter || normalize(issue.state.name) === normalize(stateFilter))
    .filter((issue) => !labelFilter || issue.labels.nodes.some((label) => (
      normalize(label.name) === normalize(labelFilter) || normalize(labelDisplay(label)) === normalize(labelFilter)
    )))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, requestedLimit)
    .map((issue) => ({
      ...issue,
      assignee: issue.assignee?.name ?? null,
      state: issue.state.name,
      labels: issue.labels.nodes.map(labelDisplay),
    }));
  print({ count: issues.length, issues });
}

async function transition(credential, args, apply) {
  const [identifier, targetName] = positional(args);
  if (!identifier || !targetName) throw new Error("transition requires an issue identifier and target state");
  const [issue, context] = await Promise.all([
    issueByIdentifier(credential, identifier),
    teamContext(credential),
  ]);
  const target = resolveState(context.states, targetName);
  const preview = {
    action: "transition",
    issue: issue.identifier,
    from: issue.state.name,
    to: target.name,
    applied: false,
  };
  if (!apply || issue.state.id === target.id) {
    print({ ...preview, noChange: issue.state.id === target.id });
    return;
  }
  const data = await graphql(
    credential,
    `mutation TransitionIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { success issue { identifier url state { name } } }
    }`,
    { id: issue.id, input: { stateId: target.id } },
  );
  print({ ...preview, applied: data.issueUpdate.success, result: data.issueUpdate.issue });
}

async function addLabels(credential, args, apply) {
  const [identifier, namesCsv] = positional(args);
  if (!identifier || !namesCsv) throw new Error("add-labels requires an issue identifier and comma-separated labels");
  const requested = namesCsv.split(",").map((name) => name.trim()).filter(Boolean);
  if (!requested.length) throw new Error("At least one label is required");
  const [issue, context] = await Promise.all([
    issueByIdentifier(credential, identifier),
    teamContext(credential),
  ]);
  const additions = resolveLabels(context.labels, requested);
  const combined = new Map(issue.labels.nodes.map((label) => [label.id, label]));
  for (const label of additions) combined.set(label.id, label);
  const before = issue.labels.nodes.map(labelDisplay).sort();
  const after = [...combined.values()].map(labelDisplay).sort();
  const preview = { action: "add-labels", issue: issue.identifier, before, after, applied: false };
  if (!apply || before.join("\n") === after.join("\n")) {
    print({ ...preview, noChange: before.join("\n") === after.join("\n") });
    return;
  }
  const data = await graphql(
    credential,
    `mutation AddIssueLabels($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) {
        success issue { identifier url labels { nodes { name parent { name } } } }
      }
    }`,
    { id: issue.id, input: { labelIds: [...combined.keys()] } },
  );
  print({
    ...preview,
    applied: data.issueUpdate.success,
    result: {
      identifier: data.issueUpdate.issue.identifier,
      url: data.issueUpdate.issue.url,
      labels: data.issueUpdate.issue.labels.nodes.map(labelDisplay).sort(),
    },
  });
}

async function addComment(credential, args, apply) {
  const [identifier] = positional(args);
  const path = option(args, "--file");
  if (!identifier || !path) throw new Error("comment requires an issue identifier and --file");
  const issue = await issueByIdentifier(credential, identifier);
  const body = readFileSync(resolve(path), "utf8").trim();
  if (!body) throw new Error("Comment file is empty");
  const preview = {
    action: "comment",
    issue: issue.identifier,
    bodyCharacters: body.length,
    bodySha256: createHash("sha256").update(body).digest("hex"),
    applied: false,
  };
  if (!apply) {
    print(preview);
    return;
  }
  const data = await graphql(
    credential,
    `mutation AddComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { success comment { id createdAt } }
    }`,
    { input: { issueId: issue.id, body } },
  );
  print({ ...preview, applied: data.commentCreate.success, result: data.commentCreate.comment });
}

async function createIssue(credential, args, apply) {
  const path = option(args, "--file");
  if (!path) throw new Error("create requires --file issue.json");
  const document = JSON.parse(readFileSync(resolve(path), "utf8"));
  if (typeof document.title !== "string" || !document.title.trim()) throw new Error("Issue title is required");
  if (document.description != null && typeof document.description !== "string") {
    throw new Error("Issue description must be a string");
  }
  const priority = document.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0 || priority > 4) {
    throw new Error("Issue priority must be an integer from 0 to 4");
  }
  if (document.labels != null && !Array.isArray(document.labels)) {
    throw new Error("Issue labels must be an array");
  }
  const context = await teamContext(credential);
  const state = resolveState(context.states, document.state || "Triage");
  const labels = resolveLabels(context.labels, document.labels || []);
  let assigneeId;
  if (document.assignee === "me") assigneeId = (await currentViewer(credential)).id;
  else if (document.assignee != null) throw new Error('Only assignee "me" or null is supported');
  const project = document.project ? await exactProject(credential, document.project) : null;
  if (document.dueDate != null && !/^\d{4}-\d{2}-\d{2}$/.test(document.dueDate)) {
    throw new Error("dueDate must use YYYY-MM-DD");
  }
  const input = {
    teamId: context.team.id,
    title: document.title.trim(),
    description: document.description?.trim() || undefined,
    priority,
    stateId: state.id,
    labelIds: labels.map((label) => label.id),
    assigneeId,
    projectId: project?.id,
    dueDate: document.dueDate,
  };
  Object.keys(input).forEach((key) => input[key] === undefined && delete input[key]);
  const preview = {
    action: "create",
    team: TEAM_KEY,
    title: input.title,
    descriptionCharacters: input.description?.length ?? 0,
    state: state.name,
    priority,
    assignee: assigneeId ? "me" : null,
    project: project?.name ?? null,
    labels: labels.map(labelDisplay).sort(),
    dueDate: input.dueDate ?? null,
    applied: false,
  };
  if (!apply) {
    print(preview);
    return;
  }
  const data = await graphql(
    credential,
    `mutation CreateHeroIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) {
        success issue { id identifier title url priority state { name } }
      }
    }`,
    { input },
  );
  print({ ...preview, applied: data.issueCreate.success, result: data.issueCreate.issue });
}

async function main() {
  const args = process.argv.slice(2);
  const command = args.shift();
  if (!command || command === "help" || command === "--help" || command === "-h") {
    usage();
    return;
  }
  const credential = resolveCredential();
  const apply = args.includes("--apply");
  if (command === "doctor") return doctor(credential);
  if (command === "list") return listIssues(credential, args);
  if (command === "issue") {
    const [identifier] = positional(args);
    if (!identifier) throw new Error("issue requires HERO-123");
    return print(await issueByIdentifier(credential, identifier));
  }
  if (command === "transition") return transition(credential, args, apply);
  if (command === "add-labels") return addLabels(credential, args, apply);
  if (command === "comment") return addComment(credential, args, apply);
  if (command === "create") return createIssue(credential, args, apply);
  throw new Error(`Unknown command: ${command}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
