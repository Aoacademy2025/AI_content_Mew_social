---
status: accepted
---

# Agents edit through a server-held Pending Edit Draft that one Export applies

On the web, Post-phase edits (caption text, merge/split, subtitle style, headline, B-roll window swaps) live only in browser state until the creator submits a re-render or Export. An MCP agent has no browser and edits across many separate tool calls, so we decided that Public HeroAI MCP edits land in a Pending Edit Draft stored on the Agent-created Project. Each small edit tool validates and saves one change. `export_video` applies the whole draft in one server chain: it re-renders B-roll only when windows changed, then exports. The web editor loads the same draft when the creator opens the project. A compare-and-swap revision means a web export and an agent export never silently overwrite each other.

## Considered Options

- **Stateless: the agent sends every edit in one large export call.** Rejected. Mistakes would surface only at export, and the large nested payload is the input shape that weaker MCP clients handle worst (Agent-neutral Tool).
- **Save each edit by re-rendering immediately.** Rejected. It costs a render per edit and contradicts "export once".

## Consequences

- Edits are free. The only paid render is the Base Render the project already paid for; the Burn and the B-roll re-render stay on the existing `isBurnAlreadyPaid` / `rerenderSkipEligible` free paths.
- A draft that is never exported changes nothing. The project still holds its last Base Render or Export.
- Re-exporting after an Export is allowed and free. The new draft starts from that Export's edits.
