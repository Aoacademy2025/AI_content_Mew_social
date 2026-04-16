"use client";

import { useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Upload,
  Sparkles,
  Download,
  Loader2,
  Image as ImageIcon,
  CheckCircle2,
} from "lucide-react";
import { toast } from "sonner";

type AvatarStyle = "Realistic" | "Anime" | "3D" | "Cartoon";

interface AvatarCloningProps {
  onGenerate?: (file: File, style: AvatarStyle) => Promise<string>;
}

export function AvatarCloning({ onGenerate }: AvatarCloningProps) {
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string>("");
  const [generatedUrl, setGeneratedUrl] = useState<string>("");
  const [selectedStyle, setSelectedStyle] = useState<AvatarStyle>("Realistic");
  const [isGenerating, setIsGenerating] = useState(false);
  const [isDragging, setIsDragging] = useState(false);

  const styles: AvatarStyle[] = ["Realistic", "Anime", "3D", "Cartoon"];

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      handleFileSelect(file);
    } else {
      toast.error("กรุณาอัปโหลดไฟล์รูปภาพเท่านั้น");
    }
  }, []);

  const handleFileSelect = (file: File) => {
    setSelectedFile(file);
    const reader = new FileReader();
    reader.onloadend = () => {
      setPreviewUrl(reader.result as string);
    };
    reader.readAsDataURL(file);
    setGeneratedUrl(""); // Reset generated image
  };

  const handleFileInput = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleFileSelect(file);
    }
  };

  const handleGenerate = async () => {
    if (!selectedFile) {
      toast.error("กรุณาอัปโหลดรูปภาพก่อน");
      return;
    }

    setIsGenerating(true);
    try {
      if (onGenerate) {
        const result = await onGenerate(selectedFile, selectedStyle);
        setGeneratedUrl(result);
        toast.success("สร้าง Avatar สำเร็จ!");
      } else {
        // Simulate generation for demo
        await new Promise((resolve) => setTimeout(resolve, 3000));
        setGeneratedUrl(previewUrl); // Demo: use same image
        toast.success("สร้าง Avatar สำเร็จ!");
      }
    } catch (error) {
      toast.error("เกิดข้อผิดพลาด กรุณาลองใหม่");
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!generatedUrl) return;

    try {
      const response = await fetch(generatedUrl);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `avatar-${selectedStyle.toLowerCase()}-${Date.now()}.png`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      window.URL.revokeObjectURL(url);
      toast.success("ดาวน์โหลดสำเร็จ!");
    } catch (error) {
      toast.error("เกิดข้อผิดพลาดในการดาวน์โหลด");
    }
  };

  return (
    <div className="relative min-h-screen overflow-hidden bg-linear-to-br from-purple-900 via-blue-900 to-indigo-900 p-6">
      {/* Animated background elements */}
      <div className="absolute inset-0 overflow-hidden">
        <div className="absolute -left-4 top-1/4 h-96 w-96 animate-pulse rounded-full bg-purple-500/20 blur-3xl" />
        <div className="absolute right-0 top-1/2 h-96 w-96 animate-pulse rounded-full bg-blue-500/20 blur-3xl delay-1000" />
        <div className="absolute bottom-0 left-1/3 h-96 w-96 animate-pulse rounded-full bg-indigo-500/20 blur-3xl delay-500" />
      </div>

      {/* Content */}
      <div className="relative z-10 mx-auto max-w-7xl">
        {/* Header */}
        <div className="mb-8 text-center">
          <div className="mb-4 flex items-center justify-center gap-2">
            <Sparkles className="h-8 w-8 text-purple-300" />
            <h1 className="bg-linear-to-r from-purple-200 to-blue-200 bg-clip-text text-4xl font-bold text-transparent">
              AI Avatar Cloning
            </h1>
          </div>
          <p className="text-lg text-purple-200/80">
            แปลงรูปของคุณให้เป็น Avatar สไตล์ที่คุณชอบด้วย AI
          </p>
        </div>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* Upload Section */}
          <Card className="border-white/10 bg-white/10 backdrop-blur-xl">
            <div className="p-6">
              <h2 className="mb-4 text-xl font-semibold text-white">
                1. อัปโหลดรูปภาพ
              </h2>

              {/* Upload Area */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`group relative overflow-hidden rounded-xl border-2 border-dashed transition-all ${
                  isDragging
                    ? "border-purple-400 bg-purple-500/20"
                    : "border-white/20 bg-white/5 hover:border-purple-400/50 hover:bg-white/10"
                }`}
              >
                <input
                  type="file"
                  accept="image/*"
                  onChange={handleFileInput}
                  className="absolute inset-0 cursor-pointer opacity-0"
                  id="file-upload"
                />

                {previewUrl ? (
                  <div className="relative aspect-square">
                    <img
                      src={previewUrl}
                      alt="Preview"
                      className="h-full w-full rounded-xl object-cover"
                    />
                    <div className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 transition-opacity group-hover:opacity-100">
                      <div className="text-center">
                        <Upload className="mx-auto mb-2 h-8 w-8 text-white" />
                        <p className="text-sm text-white">เปลี่ยนรูปภาพ</p>
                      </div>
                    </div>
                    <Badge className="absolute right-2 top-2 bg-green-500">
                      <CheckCircle2 className="mr-1 h-3 w-3" />
                      Uploaded
                    </Badge>
                  </div>
                ) : (
                  <label
                    htmlFor="file-upload"
                    className="flex aspect-square cursor-pointer flex-col items-center justify-center p-8 text-center"
                  >
                    <div className="rounded-full bg-purple-500/20 p-6 transition-transform group-hover:scale-110">
                      <ImageIcon className="h-12 w-12 text-purple-300" />
                    </div>
                    <p className="mt-4 text-lg font-medium text-white">
                      ลากไฟล์มาวางที่นี่
                    </p>
                    <p className="mt-2 text-sm text-purple-200/60">
                      หรือคลิกเพื่อเลือกไฟล์
                    </p>
                    <p className="mt-1 text-xs text-purple-200/40">
                      รองรับ: JPG, PNG, WebP
                    </p>
                  </label>
                )}
              </div>

              {/* Style Selector */}
              <div className="mt-6">
                <h3 className="mb-3 text-sm font-medium text-white">
                  2. เลือกสไตล์ Avatar
                </h3>
                <div className="grid grid-cols-2 gap-3">
                  {styles.map((style) => (
                    <button
                      key={style}
                      onClick={() => setSelectedStyle(style)}
                      className={`group relative overflow-hidden rounded-lg border-2 p-4 text-center transition-all ${
                        selectedStyle === style
                          ? "border-purple-400 bg-purple-500/30 shadow-lg shadow-purple-500/50"
                          : "border-white/10 bg-white/5 hover:border-purple-400/50 hover:bg-white/10"
                      }`}
                    >
                      <div className="relative z-10">
                        <div className="mb-2 text-2xl">
                          {style === "Realistic" && "👤"}
                          {style === "Anime" && "🎭"}
                          {style === "3D" && "🎨"}
                          {style === "Cartoon" && "🎪"}
                        </div>
                        <p
                          className={`font-medium transition-colors ${
                            selectedStyle === style
                              ? "text-white"
                              : "text-purple-200/80"
                          }`}
                        >
                          {style}
                        </p>
                      </div>
                      {selectedStyle === style && (
                        <div className="absolute inset-0 bg-linear-to-br from-purple-500/20 to-blue-500/20" />
                      )}
                    </button>
                  ))}
                </div>
              </div>

              {/* Generate Button */}
              <Button
                onClick={handleGenerate}
                disabled={!selectedFile || isGenerating}
                className="mt-6 w-full bg-linear-to-r from-purple-500 to-blue-500 text-white shadow-lg shadow-purple-500/50 transition-all hover:shadow-xl hover:shadow-purple-500/60 disabled:opacity-50"
                size="lg"
              >
                {isGenerating ? (
                  <>
                    <Loader2 className="mr-2 h-5 w-5 animate-spin" />
                    กำลังสร้าง Avatar...
                  </>
                ) : (
                  <>
                    <Sparkles className="mr-2 h-5 w-5" />
                    สร้าง Avatar
                  </>
                )}
              </Button>
            </div>
          </Card>

          {/* Result Section */}
          <Card className="border-white/10 bg-white/10 backdrop-blur-xl">
            <div className="p-6">
              <h2 className="mb-4 text-xl font-semibold text-white">
                3. ผลลัพธ์
              </h2>

              {generatedUrl ? (
                <div className="space-y-4">
                  {/* Comparison View */}
                  <div className="grid grid-cols-2 gap-4">
                    <div className="space-y-2">
                      <p className="text-sm text-purple-200/60">Original</p>
                      <div className="overflow-hidden rounded-lg border border-white/10">
                        <img
                          src={previewUrl}
                          alt="Original"
                          className="aspect-square w-full object-cover"
                        />
                      </div>
                    </div>
                    <div className="space-y-2">
                      <p className="text-sm text-purple-200/60">Generated</p>
                      <div className="overflow-hidden rounded-lg border border-purple-400/50 shadow-lg shadow-purple-500/30">
                        <img
                          src={generatedUrl}
                          alt="Generated"
                          className="aspect-square w-full object-cover"
                        />
                      </div>
                    </div>
                  </div>

                  {/* Info */}
                  <div className="rounded-lg bg-white/5 p-4">
                    <div className="flex items-center justify-between">
                      <div>
                        <p className="text-sm text-purple-200/60">Style</p>
                        <p className="font-medium text-white">
                          {selectedStyle}
                        </p>
                      </div>
                      <Badge className="bg-green-500">
                        <CheckCircle2 className="mr-1 h-3 w-3" />
                        Completed
                      </Badge>
                    </div>
                  </div>

                  {/* Download Button */}
                  <Button
                    onClick={handleDownload}
                    className="w-full bg-linear-to-r from-green-500 to-emerald-500 text-white shadow-lg shadow-green-500/50 transition-all hover:shadow-xl hover:shadow-green-500/60"
                    size="lg"
                  >
                    <Download className="mr-2 h-5 w-5" />
                    ดาวน์โหลด Avatar
                  </Button>
                </div>
              ) : (
                <div className="flex aspect-square items-center justify-center rounded-xl border-2 border-dashed border-white/10 bg-white/5">
                  <div className="text-center">
                    <div className="mx-auto mb-4 rounded-full bg-purple-500/20 p-6">
                      <Sparkles className="h-12 w-12 text-purple-300" />
                    </div>
                    <p className="text-lg font-medium text-white">
                      กำลังสร้าง Avatar
                    </p>
                    <p className="mt-2 text-sm text-purple-200/60">
                      อัปโหลดรูปภาพและเลือกสไตล์
                      <br />
                      แล้วกดปุ่มสร้างเพื่อเริ่มต้น
                    </p>
                  </div>
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* Features */}
        <div className="mt-8 grid gap-4 md:grid-cols-3">
          {[
            {
              icon: "⚡",
              title: "สร้างเร็ว",
              desc: "ใช้เวลาไม่กี่วินาที",
            },
            {
              icon: "🎨",
              title: "4 สไตล์",
              desc: "Realistic, Anime, 3D, Cartoon",
            },
            {
              icon: "✨",
              title: "คุณภาพสูง",
              desc: "ภาพคมชัด ละเอียด",
            },
          ].map((feature, i) => (
            <div
              key={i}
              className="rounded-lg border border-white/10 bg-white/5 p-4 text-center backdrop-blur-xl transition-all hover:bg-white/10"
            >
              <div className="mb-2 text-3xl">{feature.icon}</div>
              <h3 className="mb-1 font-medium text-white">{feature.title}</h3>
              <p className="text-sm text-purple-200/60">{feature.desc}</p>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
