"use client";

import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { isPortraitVideoFile } from "@/lib/video-orientation";

const MAX_AVATAR_UPLOAD_BYTES = 2 * 1024 * 1024 * 1024; // keep in sync with /api/videos/upload-avatar

type UploadResponse = {
  url?: string;
  error?: string;
  code?: string;
};

class PlanRequiredError extends Error {
  constructor(public readonly planMessage: string) {
    super(planMessage || "Plan required");
  }
}

function parseUploadResponse(text: string): UploadResponse {
  try {
    const data = JSON.parse(text) as unknown;
    return data && typeof data === "object" ? data as UploadResponse : {};
  } catch {
    return {};
  }
}

function uploadErrorMessage(status: number, data: UploadResponse) {
  if (data.error) return data.error;
  if (status === 401) return "เซสชันหมดอายุ กรุณาเข้าสู่ระบบใหม่แล้วลองอีกครั้ง";
  if (status === 413) return "ไฟล์ใหญ่เกิน 2 GB";
  if (status === 507) return "พื้นที่จัดเก็บบนเซิร์ฟเวอร์ไม่พอสำหรับอัปโหลดไฟล์นี้";
  return `อัปโหลดไม่สำเร็จ (HTTP ${status}) — ลองเข้าสู่ระบบใหม่หรือลองอีกครั้ง`;
}

export function DirectAvatarUpload({ onUrl, onPlanError, requirePortrait }: { onUrl: (url: string) => void; onPlanError?: (msg: string) => void; requirePortrait?: boolean }) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  async function handleFile(file: File) {
    if (!["mp4", "mov", "webm"].includes(file.name.split(".").pop()?.toLowerCase() ?? "")) {
      toast.error("รองรับเฉพาะ mp4 / mov / webm");
      return;
    }
    if (file.size > MAX_AVATAR_UPLOAD_BYTES) {
      toast.error("ไฟล์ใหญ่เกิน 2 GB");
      return;
    }
    if (requirePortrait && !(await isPortraitVideoFile(file))) {
      toast.error("รองรับเฉพาะคลิปแนวตั้ง (9:16) — คลิปแนวนอน/จัตุรัสยังไม่รองรับในโหมดนี้");
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      // Use XHR for upload progress on large files
      await new Promise<void>((resolve, reject) => {
        const fd = new FormData();
        fd.append("file", file);
        const xhr = new XMLHttpRequest();
        xhr.open("POST", "/api/videos/upload-avatar");
        xhr.upload.onprogress = e => { if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100)); };
        xhr.onload = () => {
          const data = parseUploadResponse(xhr.responseText);
          if (xhr.status === 200) {
            if (data.url) { onUrl(data.url); resolve(); }
            else reject(new Error(data.error ?? "อัปโหลดไม่สำเร็จ"));
          } else if (xhr.status === 403 || data.code === "plan_required") {
            reject(new PlanRequiredError(data.error ?? "Avatar ใช้ได้เฉพาะแผน Pro ขึ้นไป"));
          } else {
            // Non-JSON body (e.g. an HTML error page from the proxy) → give an
            // actionable message instead of an opaque "Upload failed".
            reject(new Error(uploadErrorMessage(xhr.status, data)));
          }
        };
        xhr.onerror = () => reject(new Error("Network error — เช็กอินเทอร์เน็ตแล้วลองอีกครั้ง"));
        xhr.onabort = () => reject(new Error("ยกเลิกการอัปโหลดแล้ว"));
        xhr.send(fd);
      });
      toast.success("อัปโหลดสำเร็จ");
    } catch (e) {
      if (e instanceof PlanRequiredError) {
        onPlanError?.(e.planMessage);
      } else {
        toast.error(e instanceof Error ? e.message : "อัปโหลดไม่สำเร็จ");
      }
    } finally {
      setUploading(false);
      setProgress(0);
    }
  }

  return (
    <label className={cn("flex flex-col items-center justify-center gap-1.5 rounded-lg py-3 cursor-pointer transition-colors border border-dashed border-[#3a3a4a] bg-[#1a1a22]", uploading && "pointer-events-none opacity-70")}>
      <input type="file" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.webm" className="hidden"
        onChange={e => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ""; }}
        disabled={uploading} />
      {uploading ? (
        <>
          <Loader2 className="h-4 w-4 animate-spin text-violet-400" />
          <span className="text-[10px] text-slate-500">กำลังอัปโหลด {progress}%</span>
          <div className="w-full px-4">
            <div className="h-1 rounded-full bg-[#2a2a36] overflow-hidden">
              <div className="h-full bg-violet-500 rounded-full transition-all" style={{ width: `${progress}%` }} />
            </div>
          </div>
        </>
      ) : (
        <>
          <Upload className="h-4 w-4 text-slate-600" />
          <span className="text-[10px] text-slate-600">อัปโหลดไฟล์วิดีโอ green screen</span>
          <span className="text-[9px] text-slate-700">mp4 / mov / webm · รองรับถึง 10 นาที</span>
        </>
      )}
    </label>
  );
}
