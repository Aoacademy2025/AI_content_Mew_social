import { NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { notifyAdmins } from "@/lib/notifications";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
  try {
    const { name, email, password } = await req.json();

    if (!name || !email || !password) {
      return NextResponse.json(
        { error: "กรุณากรอกข้อมูลให้ครบถ้วน" },
        { status: 400 }
      );
    }

    const existingUser = await prisma.user.findUnique({
      where: { email },
    });

    if (existingUser) {
      return NextResponse.json(
        { error: "อีเมลนี้ถูกใช้งานแล้ว" },
        { status: 400 }
      );
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const user = await prisma.user.create({
      data: {
        name,
        email,
        password: hashedPassword,
      },
    });

    // Notify all admins about new user
    notifyAdmins({
      type: "NEW_USER",
      title: "มีผู้ใช้งานใหม่สมัครเข้ามา",
      body: `${user.name} (${user.email}) เพิ่งสมัครใช้งานระบบ`,
    }).catch(() => {});

    return NextResponse.json(
      {
        message: "สมัครสมาชิกสำเร็จ",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
      },
      { status: 201 }
    );
  } catch (error) {
    return apiError({ route: "POST /api/auth/register", error, userMessage: "เกิดข้อผิดพลาดในการสมัครสมาชิก กรุณาลองใหม่" });
  }
}
