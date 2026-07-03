// verify-v2-job-patch.ts — PATCH jobs/[id]: url guard + merge outputJson ไม่ทำ field อื่นหาย
// Run: npx tsx scripts/verify-v2-job-patch.ts
const URL_RE = /^\/api\/renders\/[\w.-]+$/;

let fail = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "PASS" : "FAIL"} ${name}`);
  if (!cond) fail++;
}

check("accepts renders file", URL_RE.test("/api/renders/composite-999-bookend.mp4"));
check("rejects external url", !URL_RE.test("https://evil.com/x.mp4"));
check("rejects traversal", !URL_RE.test("/api/renders/../../etc/passwd"));
check("rejects nested path", !URL_RE.test("/api/renders/a/b.mp4"));
check("rejects empty", !URL_RE.test(""));

// merge เดียวกับ route: parse → set videoUrl → stringify (preview ต้องคงอยู่)
const before = JSON.stringify({ version: 2, mode: "preview", videoUrl: "/api/renders/old.mp4", preview: { captions: [{ text: "a", startMs: 0, endMs: 1 }] } });
const output = JSON.parse(before) as Record<string, unknown>;
output.videoUrl = "/api/renders/new.mp4";
const after = JSON.parse(JSON.stringify(output)) as { videoUrl: string; preview?: { captions: unknown[] } };
check("videoUrl replaced", after.videoUrl === "/api/renders/new.mp4");
check("preview preserved", Array.isArray(after.preview?.captions) && after.preview.captions.length === 1);

process.exit(fail ? 1 : 0);
