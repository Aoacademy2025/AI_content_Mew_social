export type ReturnLoopProject = {
  id: string;
  title: string;
  status: string;
  updatedAt?: string;
  lastOpenedAt?: string | null;
  createdAt?: string;
};

export type ReturnLoopAction = {
  step: 1 | 2 | 3;
  statusLabel: string;
  nextAction: string;
  ctaLabel: string;
  href: string;
  secondaryLabel?: string;
  secondaryHref?: string;
};

export function returnLoopProjectHref(projectId: string): string {
  return `/video-editor?ui=v2&projectId=${encodeURIComponent(projectId)}`;
}

export function buildReturnLoopAction(project: ReturnLoopProject): ReturnLoopAction {
  const projectHref = returnLoopProjectHref(project.id);
  if (project.status === "rendering") {
    return {
      step: 2,
      statusLabel: "กำลังเรนเดอร์",
      nextAction: "ระบบกำลังสร้างวิดีโอให้ กลับมาดูสถานะล่าสุดได้เลย",
      ctaLabel: "ดูความคืบหน้า",
      href: projectHref,
    };
  }
  if (project.status === "post") {
    return {
      step: 3,
      statusLabel: "เหลือขั้นตอนสุดท้าย",
      nextAction: "แต่งซับ ตรวจ B-roll แล้วส่งออกเป็นไฟล์พร้อมโพสต์",
      ctaLabel: "แต่งซับและส่งออก",
      href: projectHref,
    };
  }
  if (project.status === "exporting") {
    return {
      step: 3,
      statusLabel: "กำลังส่งออก",
      nextAction: "ระบบกำลังทำไฟล์สุดท้าย เปิดดูสถานะได้โดยไม่เริ่มใหม่",
      ctaLabel: "ดูการส่งออก",
      href: projectHref,
    };
  }
  if (project.status === "exported") {
    return {
      step: 3,
      statusLabel: "คลิปล่าสุดเสร็จแล้ว",
      nextAction: "เปิดผลงานเดิมเพื่อดาวน์โหลด แก้ซับ หรือต่อยอดเป็นคลิปถัดไป",
      ctaLabel: "เปิดงานล่าสุด",
      href: projectHref,
      secondaryLabel: "เริ่มคลิปใหม่",
      secondaryHref: "/video-editor?ui=v2&empty=1",
    };
  }
  return {
    step: 1,
    statusLabel: "ฉบับร่าง",
    nextAction: "กลับไปที่สคริปต์และตั้งค่าที่ค้างไว้ โดยไม่ต้องเริ่มใหม่",
    ctaLabel: "ทำงานนี้ต่อ",
    href: projectHref,
  };
}

export function selectReturnLoopProject(
  projects: readonly ReturnLoopProject[],
): ReturnLoopProject | null {
  return projects.find((project) => (
    project.status === "rendering" || project.status === "exporting"
  )) ?? projects.find((project) => (
    project.status === "post" || project.status === "draft"
  )) ?? projects.find((project) => project.status === "exported") ?? null;
}
