//   npx tsx scripts/verify-project-menu-filter.ts
import {
  PROJECT_STATUS_FILTER_LABEL,
  filterProjectMenuItems,
  projectDeleteBlocked,
  projectStatusLabel,
  type ProjectMenuItem,
} from "../src/app/(dashboard)/video-editor/_v2/project-menu";
import fs from "fs";

let passed = 0;
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error("FAIL " + message);
    process.exit(1);
  }
  console.log("PASS " + message);
  passed++;
}

const P = (id: string, status: string): ProjectMenuItem => ({ id, title: id, status });
const projects = [
  P("draft-a", "draft"),
  P("post-a", "post"),
  P("rendering-a", "rendering"),
  P("exporting-a", "exporting"),
  P("exported-a", "exported"),
  P("draft-b", "draft"),
];

assert(PROJECT_STATUS_FILTER_LABEL.draft === "ฉบับร่าง", "draft filter has Thai label");
assert(projectStatusLabel("draft") === "ฉบับร่าง", "draft status label is Thai");
assert(projectStatusLabel("post") === "แต่งต่อ", "post status label is action-oriented");
assert(filterProjectMenuItems(projects, "all").length === projects.length, "all filter keeps all projects");
assert(filterProjectMenuItems(projects, "draft").map((p) => p.id).join(",") === "draft-a,draft-b", "draft filter returns only draft projects in order");
assert(filterProjectMenuItems(projects, "working").map((p) => p.id).join(",") === "rendering-a,exporting-a", "working filter returns active jobs");
assert(filterProjectMenuItems(projects, "finished").map((p) => p.id).join(",") === "post-a,exported-a", "finished filter returns post/exported projects");
assert(projectDeleteBlocked("rendering") && projectDeleteBlocked("exporting"), "active jobs cannot be deleted");
assert(!projectDeleteBlocked("draft") && !projectDeleteBlocked("post"), "draft/post projects can be deleted");

const gallery = fs.readFileSync("src/app/(dashboard)/videos/page.tsx", "utf8");
assert(gallery.includes("/api/editor-projects"), "Gallery fetches editor projects");
assert(gallery.includes("drafts"), "Gallery exposes a draft filter");
assert(gallery.includes("ProjectCard"), "Gallery renders project cards");

console.log(`\n${passed} checks passed`);
