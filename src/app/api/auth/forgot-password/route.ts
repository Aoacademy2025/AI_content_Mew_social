import { NextResponse } from "next/server";
import crypto from "crypto";
import { prisma } from "@/lib/prisma";
import { apiError } from "@/lib/api-error";

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

    if (!user) {
      // Return success anyway to prevent email enumeration
      return NextResponse.json(
        { message: "หากอีเมลนี้มีอยู่ในระบบ เราได้ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว" },
        { status: 200 }
      );
    }

    const resetToken = crypto.randomBytes(32).toString("hex");
    const resetExpires = new Date(Date.now() + 3600000); // 1 hour

    await prisma.user.update({
      where: { email },
      data: {
        resetToken,
        resetExpires,
      },
    });

    // In development, just log the reset URL
    const resetUrl = `${process.env.NEXTAUTH_URL}/reset-password?token=${resetToken}`;
    console.log("Password reset URL:", resetUrl);

    // TODO: Send email with nodemailer in production
    // await sendEmail({
    //   to: email,
    //   subject: "รีเซ็ตรหัสผ่าน - Intelligent Media Studio",
    //   text: `คลิกลิงก์นี้เพื่อรีเซ็ตรหัสผ่าน: ${resetUrl}`,
    // });

    return NextResponse.json(
      { message: "ส่งลิงก์รีเซ็ตรหัสผ่านแล้ว" },
      { status: 200 }
    );
  } catch (error) {
    return apiError({ route: "auth/forgot-password", error });
  }
}
