import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";

export const authOptions: NextAuthOptions = {
  providers: [
    CredentialsProvider({
      name: "credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("กรุณากรอกอีเมลและรหัสผ่าน");
        }

        const user = await prisma.user.findUnique({
          where: { email: credentials.email },
        });

        if (!user) {
          throw new Error("ไม่พบบัญชีผู้ใช้นี้");
        }

        const isValid = await bcrypt.compare(
          credentials.password,
          user.password
        );

        if (!isValid) {
          throw new Error("รหัสผ่านไม่ถูกต้อง");
        }

        if (user.suspended) {
          throw new Error("บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ");
        }

        return {
          id: user.id,
          name: user.name,
          email: user.email,
          role: user.role,
          plan: user.plan,
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        // Initial login — set from auth result
        token.id = user.id;
        token.role = (user as any).role;
        token.plan = (user as any).plan;
      } else if (token.id) {
        // Subsequent requests — sync plan & role from DB so upgrades reflect immediately
        const dbUser = await prisma.user.findUnique({
          where: { id: token.id as string },
          select: { plan: true, role: true, suspended: true },
        });
        if (dbUser) {
          token.plan = dbUser.plan as "FREE" | "PRO";
          token.role = dbUser.role as "ADMIN" | "USER";
          // Force sign-out if suspended after login
          if (dbUser.suspended) {
            return { ...token, error: "suspended" };
          }
        }
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        (session.user as any).id = token.id;
        (session.user as any).role = token.role;
        (session.user as any).plan = token.plan;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  session: {
    strategy: "jwt",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
