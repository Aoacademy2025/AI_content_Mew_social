import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import GoogleProvider from "next-auth/providers/google";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { syncUserEntitlement } from "@/lib/entitlements";

export const authOptions: NextAuthOptions = {
  providers: [
    GoogleProvider({
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
    }),
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

        if (!user.password) {
          throw new Error("บัญชีนี้ใช้ Google Sign-In กรุณาเข้าสู่ระบบด้วย Google");
        }

        const isValid = await bcrypt.compare(
          credentials.password,
          user.password
        );

        if (!isValid) {
          throw new Error("รหัสผ่านไม่ถูกต้อง");
        }

        await syncUserEntitlement(user.id);
        const syncedUser = await prisma.user.findUnique({ where: { id: user.id } });
        if (!syncedUser) throw new Error("ไม่พบบัญชีผู้ใช้นี้");

        if (syncedUser.suspended) {
          throw new Error("บัญชีนี้ถูกระงับ กรุณาติดต่อผู้ดูแลระบบ");
        }

        return {
          id: syncedUser.id,
          name: syncedUser.name,
          email: syncedUser.email,
          role: syncedUser.role,
          plan: syncedUser.plan,
        };
      },
    }),
  ],
  callbacks: {
    async signIn({ user, account }) {
      if (account?.provider === "google") {
        const email = user.email!;
        let dbUser = await prisma.user.findUnique({ where: { email } });
        if (!dbUser) {
          dbUser = await prisma.user.create({
            data: {
              email,
              name: user.name ?? email.split("@")[0],
              googleId: account.providerAccountId,
              image: user.image ?? null,
              password: null,
            },
          });
        } else if (!dbUser.googleId) {
          await prisma.user.update({
            where: { email },
            data: { googleId: account.providerAccountId, image: user.image ?? undefined },
          });
        }
        await syncUserEntitlement(dbUser.id);
        dbUser = await prisma.user.findUnique({ where: { id: dbUser.id } });
        if (!dbUser || dbUser.suspended) return false;
        // patch user id so jwt callback gets it
        user.id = dbUser.id;
        (user as any).role = dbUser.role;
        (user as any).plan = dbUser.plan;
      }
      return true;
    },
    async jwt({ token, user }) {
      if (user) {
        // Initial login — set from auth result
        token.id = user.id;
        token.role = (user as any).role;
        token.plan = (user as any).plan;
      } else if (token.id) {
        // Subsequent requests — sync plan & role from DB so upgrades reflect immediately
        await syncUserEntitlement(token.id as string);
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
