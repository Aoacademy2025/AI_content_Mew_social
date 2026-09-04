# Linear API operations

Use the bundled CLI from the repository root or any Orca worktree:

```bash
LINEAR_CLI=.agents/skills/hero-studio-ops/scripts/linear.mjs
node "$LINEAR_CLI" doctor
node "$LINEAR_CLI" list --state Triage
node "$LINEAR_CLI" list --label "Execution / Agent-ready"
node "$LINEAR_CLI" issue HERO-1
```

The CLI resolves a credential without printing it, in this order:

1. `LINEAR_API_KEY` or legacy `linear_api` in the current process;
2. either key in `.env` from the current checkout or a Git worktree of the same repository;
3. macOS Keychain service `heroai-linear-api-key`.

The key is sent as Linear's raw `Authorization` header. Never add `Bearer`, echo the key, place it in command arguments, commit it, or copy it into an issue/comment.

## Guarded mutations

Every mutation is a preview unless `--apply` is present:

```bash
node "$LINEAR_CLI" transition HERO-12 "In Progress"
node "$LINEAR_CLI" transition HERO-12 "In Progress" --apply

node "$LINEAR_CLI" add-labels HERO-12 "Bug,Area / Render,Execution / Agent-ready,Risk / Production"
node "$LINEAR_CLI" add-labels HERO-12 "Bug,Area / Render,Execution / Agent-ready,Risk / Production" --apply

node "$LINEAR_CLI" comment HERO-12 --file /path/to/sanitized-comment.md
node "$LINEAR_CLI" comment HERO-12 --file /path/to/sanitized-comment.md --apply
```

Use `--apply` only when the current user request authorizes that specific external write. Preview output includes identifiers and change intent but omits comment bodies and credentials.

## Creating an issue

Prepare a temporary JSON document:

```json
{
  "title": "Render export times out after composition",
  "description": "## Customer impact\n...",
  "state": "Triage",
  "priority": 2,
  "assignee": "me",
  "labels": ["Bug", "Area / Render", "Execution / Agent-ready", "Risk / Production"]
}
```

Then preview and apply:

```bash
node "$LINEAR_CLI" create --file /path/to/issue.json
node "$LINEAR_CLI" create --file /path/to/issue.json --apply
```

Optional fields are `project` (exact Linear project name) and `dueDate` (`YYYY-MM-DD`). The team is fixed to `HERO`. State and label names must match the workspace contract; grouped names such as `Area / Render` disambiguate labels.

The CLI is an execution helper, not an authorization mechanism. Inspect the preview and the user's requested scope before applying.
