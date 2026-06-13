import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";

// Constant-time string compare — edge-runtime safe (no Node crypto), avoids
// leaking the service secret via comparison timing.
function timingSafeStrEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const isPublicRoute = createRouteMatcher([
  "/",
  "/login(.*)",
  "/register(.*)",
  "/forgot-password(.*)",
  "/reset-password(.*)",
  "/pricing(.*)",
  "/api/clerk-webhook(.*)",
  "/api/payments/webhook(.*)",
  "/api/plans(.*)",
  "/api/founding/status(.*)",
  "/api/stocks(.*)",
  "/api/renders(.*)",
  "/api/music(.*)",
  "/api/telemetry(.*)",
  "/api/cron(.*)",  // protected by CRON_SECRET inside each route
  "/api/mcp(.*)",   // MCP server — authed by PAT (Bearer) inside the route, no Clerk session
]);

const isAdminRoute = createRouteMatcher([
  "/admin(.*)",
  "/style(.*)",
  "/content(.*)",
]);

const isAuthRoute = createRouteMatcher(["/login(.*)", "/register(.*)"]);

export default clerkMiddleware(async (auth, req) => {
  const { userId, sessionClaims } = await auth();

  // Redirect logged-in users away from auth pages and homepage → dashboard
  if (isAuthRoute(req) && userId) {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (userId && req.nextUrl.pathname === "/") {
    return NextResponse.redirect(new URL("/dashboard", req.url));
  }

  if (isPublicRoute(req)) return NextResponse.next();

  // Internal service calls (MCP orchestrator) carry a server-only secret header.
  // Entitlement is enforced inside each route via getCurrentUser → no Clerk session needed.
  const mcpSecret = process.env.MCP_SERVICE_SECRET;
  const svcHeader = req.headers.get("x-heroai-service-secret");
  if (mcpSecret && svcHeader && timingSafeStrEqual(svcHeader, mcpSecret) && req.headers.get("x-heroai-act-as")) {
    return NextResponse.next();
  }

  if (!userId) {
    const loginUrl = new URL("/login", req.url);
    loginUrl.searchParams.set("redirect_url", req.nextUrl.pathname);
    return NextResponse.redirect(loginUrl);
  }

  // Admin route — role is stored in Prisma, not Clerk publicMetadata.
  // Let the request through; each admin page calls requireUser() and checks role itself.

  return NextResponse.next();
});

export const config = {
  matcher: [
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    "/(api|trpc)(.*)",
  ],
};
