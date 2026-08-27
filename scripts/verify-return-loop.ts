import { buildReturnLoopAction, selectReturnLoopProject } from "../src/lib/return-loop";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const selected = selectReturnLoopProject([
  { id: "recent-post", title: "คลิปพร้อมแต่ง", status: "post" },
  { id: "active-render", title: "คลิปกำลังทำ", status: "rendering" },
  { id: "archived", title: "งานที่ลบแล้ว", status: "archived" },
]);

assert(selected?.id === "active-render", "งานที่กำลังเรนเดอร์ต้องมาก่อนงานสถานะอื่น");

const unfinished = selectReturnLoopProject([
  { id: "latest-export", title: "ส่งออกแล้ว", status: "exported" },
  { id: "unfinished-draft", title: "งานที่ยังค้าง", status: "draft" },
  { id: "archived", title: "งานที่ลบแล้ว", status: "archived" },
]);

assert(unfinished?.id === "unfinished-draft", "งานที่ยังไม่จบต้องมาก่อนงานที่ส่งออกแล้ว");

const projectId = "project/with spaces";
const actions = {
  draft: buildReturnLoopAction({ id: projectId, title: "Draft", status: "draft" }),
  rendering: buildReturnLoopAction({ id: projectId, title: "Render", status: "rendering" }),
  post: buildReturnLoopAction({ id: projectId, title: "Post", status: "post" }),
  exporting: buildReturnLoopAction({ id: projectId, title: "Export", status: "exporting" }),
  exported: buildReturnLoopAction({ id: projectId, title: "Done", status: "exported" }),
};

assert(actions.draft.step === 1 && actions.draft.ctaLabel === "ทำงานนี้ต่อ", "Draft ต้องกลับไปทำขั้นแรก");
assert(actions.rendering.step === 2 && actions.rendering.ctaLabel === "ดูความคืบหน้า", "Rendering ต้องเปิดสถานะงาน");
assert(actions.post.step === 3 && actions.post.ctaLabel === "แต่งซับและส่งออก", "Post ต้องบอกขั้นตอนสุดท้าย");
assert(actions.exporting.step === 3 && actions.exporting.ctaLabel === "ดูการส่งออก", "Exporting ต้องเปิดสถานะส่งออก");
assert(
  actions.draft.href === "/video-editor?ui=v2&projectId=project%2Fwith%20spaces",
  "ลิงก์ทำต่อต้องชี้ projectId เดิมแบบ URL-safe",
);
assert(
  actions.exported.href === "/video-editor?ui=v2&projectId=project%2Fwith%20spaces"
    && actions.exported.secondaryHref === "/video-editor?ui=v2&empty=1",
  "งานที่จบแล้วต้องเปิดงานเดิมได้ในคลิกเดียวและมีทางเริ่มคลิปใหม่",
);

console.log("verify-return-loop: PASS");
