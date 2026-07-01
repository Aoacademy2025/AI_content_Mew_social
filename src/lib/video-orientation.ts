/** Resolve a video File's intrinsic dimensions in the browser (no upload). */
export function readVideoDimensions(file: File): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement("video");
    v.preload = "metadata";
    v.onloadedmetadata = () => {
      URL.revokeObjectURL(url);
      resolve({ width: v.videoWidth, height: v.videoHeight });
    };
    v.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("อ่านไฟล์วิดีโอไม่ได้"));
    };
    v.src = url;
  });
}

/** true when the clip is portrait (taller than wide). Phase 1 accepts portrait only. */
export async function isPortraitVideoFile(file: File): Promise<boolean> {
  try {
    const { width, height } = await readVideoDimensions(file);
    return height > 0 && width > 0 && height > width;
  } catch {
    return true; // fail-open: if we can't read metadata, don't block the upload
  }
}
