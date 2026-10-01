import assert from "node:assert/strict";
import {
  PROJECT_MENU_LIMIT,
  fetchRecentProjectMenu,
  projectMenuAgentLabel,
  projectMenuDate,
} from "../src/app/(dashboard)/video-editor/_v2/project-menu";

function response(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

async function main() {
  const projects = Array.from({ length: PROJECT_MENU_LIMIT + 1 }, (_, index) => ({
    id: `project-${index + 1}`,
    title: `Project ${index + 1}`,
    status: "draft",
  }));
  const snapshot = await fetchRecentProjectMenu(
    async () => response(200, { projects }) as never,
  );
  assert.equal(snapshot.projects.length, PROJECT_MENU_LIMIT);
  assert.equal(snapshot.total, PROJECT_MENU_LIMIT + 1);
  assert.equal(snapshot.projects.at(-1)?.id, `project-${PROJECT_MENU_LIMIT}`);
  assert.ok(
    projectMenuDate({
      id: "dated-project",
      title: "New Project",
      status: "draft",
      updatedAt: "2026-07-17T08:30:00.000Z",
    }),
    "duplicate project titles can be distinguished by a stable activity date",
  );

  await assert.rejects(
    fetchRecentProjectMenu(async () => response(503, { error: "unavailable" }) as never),
    /โหลดรายการโปรเจกต์ไม่สำเร็จ/,
    "HTTP failures must reject so the delete flow can preserve its fallback list",
  );
  await assert.rejects(
    fetchRecentProjectMenu(async () => response(200, { projects: null }) as never),
    /โหลดรายการโปรเจกต์ไม่สำเร็จ/,
    "malformed success payloads must preserve the existing menu instead of pretending it is empty",
  );

  // T9 (ADR 0063): the Agent-created Project label is exactly this Thai string,
  // shown only when createdVia is the literal "mcp" the server ever surfaces.
  assert.equal(
    projectMenuAgentLabel({ id: "a", title: "x", status: "draft", createdVia: "mcp" }),
    "สร้างผ่าน AI agent",
    "an MCP-created project shows the exact Agent-created label",
  );
  assert.equal(
    projectMenuAgentLabel({ id: "b", title: "x", status: "draft" }),
    null,
    "a project with no createdVia shows no label",
  );
  assert.equal(
    projectMenuAgentLabel({ id: "c", title: "x", status: "draft", createdVia: "not-mcp" as never }),
    null,
    "any value other than the literal \"mcp\" shows no label",
  );

  console.log("ALL PROJECT-MENU CHECKS PASSED");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
