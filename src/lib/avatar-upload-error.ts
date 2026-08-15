export type UploadErrorData = {
  error?: string;
  code?: string;
};

export type UploadSessionState = "active" | "expired" | "unknown";

type FetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export async function probeUploadSession(
  fetcher: FetchLike = fetch,
): Promise<UploadSessionState> {
  try {
    const response = await fetcher("/api/user/me", {
      cache: "no-store",
      credentials: "same-origin",
    });
    if (response.ok) return "active";
    if (response.status === 401) return "expired";
    return "unknown";
  } catch {
    return "unknown";
  }
}

export function uploadErrorMessage(
  status: number,
  data: UploadErrorData,
  sessionState: UploadSessionState = "unknown",
): string {
  if (status === 401 || data.code === "unauthorized") {
    if (sessionState === "active") {
      return "อัปโหลดใช้เวลานานเกินไป กรุณาลองอีกครั้งได้เลยโดยไม่ต้องเข้าสู่ระบบใหม่";
    }
    if (sessionState === "expired") {
      return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง";
    }
    return "ตรวจสอบเซสชันไม่สำเร็จ กรุณารีเฟรชหน้าแล้วลองอีกครั้ง";
  }
  if (data.error) return data.error;
  if (status === 413) return "ไฟล์ใหญ่เกิน 500 MB";
  if (status === 507) return "พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอสำหรับอัปโหลดไฟล์นี้";
  return `อัปโหลดไม่สำเร็จ (HTTP ${status}) — ลองเข้าสู่ระบบใหม่หรือลองอีกครั้ง`;
}
