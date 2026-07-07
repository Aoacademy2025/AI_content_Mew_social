import { clerkMiddleware, createRouteMatcher } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import { timingSafeStrEqual } from "@/lib/timing-safe-equal";

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
  "/api/health(.*)",   // public up/down probe for the OS watchdog (no auth, SELECT 1)
  "/api/founding/status(.*)",
  "/api/stocks(.*)",
  "/api/renders(.*)",
  "/api/music(.*)",
  "/api/telemetry(.*)",
  "/api/cron(.*)",  // protected by CRON_SECRET inside each route
  "/api/mcp(.*)",   // MCP server — authed by PAT/OAuth (Bearer) inside the route, no Clerk session
  "/.well-known/(.*)", // OAuth discovery metadata for MCP (fetched unauthenticated by clients)
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
    // API routes: return 401 JSON so fetch/XHR callers get a clean, parseable
    // error. A 307 redirect to /login is auto-followed by the browser → it
    // re-POSTs to /login (a page-only route, no POST handler) → 500 HTML →
    // callers that do JSON.parse(responseText) fail and surface an opaque
    // "Upload failed". Pages still redirect to the sign-in screen as before.
    if (req.nextUrl.pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
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
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest|mp4|webm|mov)).*)",
    "/(api|trpc)(.*)",
  ],
};
