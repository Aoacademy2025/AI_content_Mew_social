"use client";

import { useState } from "react";
import { Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function DirectAvatarUpload({ onUrl, onPlanError }: { onUrl: (url: string) => void; onPlanError?: (msg: string) => void }) {
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);

  async function handleFile(file: File) {
    if (!["mp4", "mov", "webm"].includes(file.name.split(".").pop()?.toLowerCase() ?? "")) {
      toast.error("รองรับเฉพาะ mp4 / mov / webm");
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
          if (xhr.status === 200) {
            const data = JSON.parse(xhr.responseText);
            if (data.url) { onUrl(data.url); resolve(); }
            else reject(new Error(data.error ?? "Upload failed"));
          } else if (xhr.status === 403) {
            try {
              const data = JSON.parse(xhr.responseText);
              const err = new Error(data.error ?? "Plan required");
              (err as any)._isPlanError = true;
              (err as any)._planMessage = data.error;
              reject(err);
            } catch { reject(new Error("Plan required")); }
          } else {
            try { reject(new Error(JSON.parse(xhr.responseText).error ?? "Upload failed")); }
            catch { reject(new Error("Upload failed")); }
          }
        };
        xhr.onerror = () => reject(new Error("Network error"));
        xhr.send(fd);
      });
      toast.success("อัปโหลดสำเร็จ");
    } catch (e) {
      if (e instanceof Error && (e as any)._isPlanError) {
        onPlanError?.(((e as any)._planMessage) ?? "");
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
