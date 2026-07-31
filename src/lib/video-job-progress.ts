export type VideoJobProgressPresentation = {
  percent: number;
  indeterminate: boolean;
  ringText: string | null;
  statusText: string | null;
};

export function videoJobProgressPresentation(
  currentStep: string | null,
  rawProgress: number,
): VideoJobProgressPresentation {
  const percent = Math.max(0, Math.min(100, Math.round(rawProgress)));
  if (currentStep === "composite") {
    return {
      percent,
      indeterminate: true,
      ringText: null,
      statusText: "กำลังประกอบวิดีโอและตรวจสอบไฟล์ผลลัพธ์",
    };
  }
  return {
    percent,
    indeterminate: false,
    ringText: `${percent}%`,
    statusText: null,
  };
}
