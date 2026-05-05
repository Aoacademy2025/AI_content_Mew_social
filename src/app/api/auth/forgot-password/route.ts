import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";
import { sendPasswordResetEmail } from "@/lib/send-email";

export async function POST(req: Request) {
  try {
    const { email } = await req.json();

    if (!email) {
      return NextResponse.json(
        { error: "กรุณากรอกอีเมล" },
        { status: 400 }
      );
    }

    const user = await prisma.user.findUnique({
      where: { email },
    });

    // Always return success to prevent email enumeration
    const successResponse = NextResponse.json(
      { message: "หากอีเมลนี้มีอยู่ในระบบ เราได้ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว" },
      { status: 200 }
    );

    if (!user) {
      return successResponse;
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpires = new Date(Date.now() + 3600000); // 1 hour

    await prisma.user.update({
      where: { email },
      data: { resetToken, resetExpires },
    });

    const baseUrl = process.env.NEXTAUTH_URL ?? "http://localhost:3000";
    const resetUrl = `${baseUrl}/reset-password?token=${resetToken}`;

    const sent = await sendPasswordResetEmail(email, resetUrl);
    if (!sent) {
      // SMTP not configured — log for manual recovery
      console.warn("[forgot-password] SMTP not configured. Reset URL for", email, ":", resetUrl);
    }

    return successResponse;
  } catch (error) {
    return apiError({ route: "auth/forgot-password", error });
  }
}
