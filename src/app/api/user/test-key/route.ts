import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";
import { authOptions } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

function decrypt(encrypted: string): string {
  return Buffer.from(encrypted, "base64").toString("utf-8");
}

type KeyType = "openai" | "gemini" | "heygen" | "elevenlabs" | "pexels" | "pixabay";

async function testOpenAI(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${key}` } });
    if (res.ok) return { ok: true, message: "OpenAI key ใช้งานได้" };
    if (res.status === 401) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    if (res.status === 429) return { ok: true, message: "Key ถูกต้อง (rate limit)" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ OpenAI ได้" }; }
}

async function testGemini(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${key}`);
    if (res.ok) return { ok: true, message: "Gemini key ใช้งานได้" };
    if (res.status === 400 || res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Gemini ได้" }; }
}

async function testHeyGen(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.heygen.com/v2/avatars?limit=1", { headers: { "X-Api-Key": key } });
    if (res.ok) return { ok: true, message: "HeyGen key ใช้งานได้" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ HeyGen ได้" }; }
}

async function testElevenLabs(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.elevenlabs.io/v1/user", { headers: { "xi-api-key": key } });
    if (res.ok) return { ok: true, message: "ElevenLabs key ใช้งานได้" };
    if (res.status === 401) return { ok: false, message: "Key ไม่ถูกต้องหรือหมดอายุ" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ ElevenLabs ได้" }; }
}

async function testPexels(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch("https://api.pexels.com/videos/search?query=nature&per_page=1", { headers: { Authorization: key } });
    if (res.ok) return { ok: true, message: "Pexels key ใช้งานได้" };
    if (res.status === 401 || res.status === 403) return { ok: false, message: "Key ไม่ถูกต้อง" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Pexels ได้" }; }
}

async function testPixabay(key: string): Promise<{ ok: boolean; message: string }> {
  try {
    const res = await fetch(`https://pixabay.com/api/videos/?key=${key}&q=nature&per_page=3`);
    if (res.ok) {
      const data = await res.json();
      if (data.hits !== undefined) return { ok: true, message: "Pixabay key ใช้งานได้" };
    }
    if (res.status === 400 || res.status === 401) return { ok: false, message: "Key ไม่ถูกต้อง" };
    return { ok: false, message: `Error ${res.status}` };
  } catch { return { ok: false, message: "ไม่สามารถเชื่อมต่อ Pixabay ได้" }; }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { keyType } = (await req.json()) as { keyType: KeyType };

    const user = await prisma.user.findUnique({
      where: { id: (session.user as { id: string }).id },
      select: { openaiKey: true, geminiKey: true, heygenKey: true, elevenlabsKey: true, pexelsKey: true, pixabayKey: true },
    });
    if (!user) return NextResponse.json({ error: "User not found" }, { status: 404 });

    const encryptedMap: Record<KeyType, string | null | undefined> = {
      openai:     user.openaiKey,
      gemini:     user.geminiKey,
      heygen:     user.heygenKey,
      elevenlabs: user.elevenlabsKey,
      pexels:     user.pexelsKey,
      pixabay:    user.pixabayKey,
    };

    const encrypted = encryptedMap[keyType];
    if (!encrypted) return NextResponse.json({ ok: false, message: "ยังไม่ได้บันทึก key นี้" });

    const key = decrypt(encrypted);

    let result: { ok: boolean; message: string };
    switch (keyType) {
      case "openai":     result = await testOpenAI(key);     break;
      case "gemini":     result = await testGemini(key);     break;
      case "heygen":     result = await testHeyGen(key);     break;
      case "elevenlabs": result = await testElevenLabs(key); break;
      case "pexels":     result = await testPexels(key);     break;
      case "pixabay":    result = await testPixabay(key);    break;
      default: return NextResponse.json({ error: "Unknown key type" }, { status: 400 });
    }

    return NextResponse.json(result);
  } catch (error) {
    return apiError({ route: "user/test-key", error });
  }
}
