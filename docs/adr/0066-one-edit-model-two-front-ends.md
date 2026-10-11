---
status: accepted
---

# One server-side edit model, two front-ends: the web editor and MCP

Hero now has two ways to edit a video: the web editor (`/video-editor`) and the Public HeroAI MCP tools that agents call. ADR 0064 put MCP edits in a server-held Pending Edit Draft, while web Post-phase edits still live in browser state until a re-render or Export. Edits that exist in only one place go missing: a headline hook and B-roll window replacements reset after an Export (EP5 backlog #7, #15), and an agent can hand the creator an `editorUrl` whose editor cannot show or undo what the agent did.

We decided that **every capability that changes the output video is built once, in a shared server-side edit model, and both front-ends are thin clients of it.**

1. **Core first.** A new output-changing capability starts as a field in the project's edit model, with one server validator and renderer support. The web control and the MCP tool only read and write that field.
2. **Done means both front-ends.** A capability is finished when the web editor and MCP can both use it, in one PR or in back-to-back PRs. If only one fits the deadline, ship the web editor first, because every customer has it and creators check an agent's work there. Never ship an output-changing capability that only MCP can reach.
3. **Allowed one-sided cases.**
   - *Observation tools for agents* (`get_edit_state`, a preview-frame tool) exist because an agent cannot see the preview. A human already sees it, so these need no web control.
   - *Quality defaults applied for everyone* (audio/video sync, colour range, loudness) need no control on either side.
   - *Web-only conveniences* that do not change the output (layout, previews, shortcuts) need no MCP tool.
4. **Direction for the web editor.** Web Post-phase edits move into the same server-held draft over time, so an agent's edits open in the web editor and a creator's web edits are visible to the agent. Until then, every new draft field must survive Export (persisted into `EditorProject.draftJson`) and be readable by the web editor.

## Considered Options

- **Web first, MCP later, as separate implementations.** Rejected. Two implementations of one capability drift apart, which is exactly how edits got lost on Export.
- **MCP-only features for agents.** Rejected. Creators could not fix an agent's work in the editor, support could not see it, and most customers do not use agents yet.

## Consequences

- Each new editing feature costs a little more up front (a web control alongside the tool), and the two front-ends cannot disagree.
- Reviewers check one question for every output-changing PR: is it in the shared model, and can both front-ends reach it?
- Supersedes nothing. It extends ADR 0064: the Pending Edit Draft is the shared model's storage, and this ADR makes the web editor its second client.
