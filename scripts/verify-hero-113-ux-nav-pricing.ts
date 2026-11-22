import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

const mobileSidebar = readFileSync(
  path.join(REPO_ROOT, "src/components/layout/mobile-sidebar.tsx"),
  "utf8",
);
const sidebar = readFileSync(
  path.join(REPO_ROOT, "src/components/layout/sidebar.tsx"),
  "utf8",
);
const topNav = readFileSync(
  path.join(REPO_ROOT, "src/components/layout/top-nav.tsx"),
  "utf8",
);
const bottomTabs = readFileSync(
  path.join(REPO_ROOT, "src/components/layout/bottom-tabs.tsx"),
  "utf8",
);
const pricingPage = readFileSync(
  path.join(REPO_ROOT, "src/app/(dashboard)/pricing/page.tsx"),
  "utf8",
);

// ── 1. MobileSidebar auto-close + 44x44px touch target ─────────────────────
assert.match(
  mobileSidebar,
  /usePathname/,
  "MobileSidebar watches pathname changes to close the drawer automatically",
);
assert.match(
  mobileSidebar,
  /useEffect\(/,
  "MobileSidebar uses useEffect to react to pathname transitions",
);
assert.match(
  mobileSidebar,
  /onOpenChange\(false\)/,
  "MobileSidebar closes itself via onOpenChange(false)",
);
assert.match(
  mobileSidebar,
  /<Sidebar[^>]*onNavigate=\{\(\) => onOpenChange\(false\)\}/,
  "MobileSidebar forwards onNavigate callback to Sidebar",
);
assert.match(
  mobileSidebar,
  /aria-label="ปิดเมนู"[\s\S]*?h-11 w-11/,
  "MobileSidebar close button is a >=44x44px (h-11 w-11) touch target",
);
assert.doesNotMatch(
  mobileSidebar,
  /\bh-7 w-7\b/,
  "MobileSidebar close button no longer uses the tiny 28x28px target",
);

// ── 2. Sidebar onNavigate + Upgrade CTA -> /pricing + cleaner grouping ─────
assert.match(
  sidebar,
  /onNavigate\?:\s*\(\)\s*=>\s*void/,
  "Sidebar exposes optional onNavigate prop",
);
assert.ok(
  (sidebar.match(/onNavigate\?\.\(\)/g) ?? []).length >= 5,
  "Sidebar invokes onNavigate?.() on nav links and bottom CTA links",
);

const bottomSectionStart = sidebar.indexOf("{/* Bottom */}");
assert.ok(bottomSectionStart >= 0, "Sidebar has Bottom CTA section");
const bottomSection = sidebar.slice(bottomSectionStart);
assert.doesNotMatch(
  bottomSection,
  /href="\/settings\?tab=billing"/,
  "Sidebar bottom Upgrade CTAs must not leak users to /settings?tab=billing",
);
assert.match(
  bottomSection,
  /href="\/pricing\?source=sidebar"[\s\S]*?อัปเกรดเป็น PRO/,
  "FREE / expired users Upgrade CTA routes to /pricing?source=sidebar with Thai label",
);
assert.match(
  bottomSection,
  /href="\/pricing\?source=sidebar&plan=BUSINESS"[\s\S]*?อัปเกรดเป็น Business/,
  "PRO users Upgrade CTA routes to /pricing?source=sidebar&plan=BUSINESS with Thai label",
);

const userNavStart = sidebar.indexOf("const userNavItems: SidebarNavItem[] = [");
const userNavEnd = sidebar.indexOf("\n];", userNavStart);
const userNavBlock = sidebar.slice(userNavStart, userNavEnd);
assert.doesNotMatch(
  userNavBlock,
  /href:\s*"\/hero-script"[^\n]*badgeText:\s*"ใหม่"/,
  "/hero-script no longer carries stale ใหม่ badge",
);
assert.doesNotMatch(
  userNavBlock,
  /href:\s*"\/brands"[^\n]*badgeText:\s*"ใหม่"/,
  "/brands no longer carries stale ใหม่ badge",
);
assert.match(
  userNavBlock,
  /href:\s*"\/mcp"[^\n]*badgeText:\s*"ใหม่"/,
  "/mcp keeps the single ใหม่ badge",
);
assert.match(
  sidebar,
  /item\.href === "\/hero-script" && !heroScriptAllowed[\s\S]*?badgeText:\s*"PRO"/,
  "/hero-script retains dynamic PRO badge when not heroScriptAllowed",
);
assert.match(
  sidebar,
  /<SectionLabel collapsed=\{collapsed\}>สร้างงาน<\/SectionLabel>[\s\S]*?<SectionLabel collapsed=\{collapsed\} withDivider>เครื่องมือ/,
  "Non-admin Sidebar visually groups creation vs tools/account items",
);
assert.match(sidebar, /trackEvent\("hero_script_menu_clicked"/, "hero_script_menu_clicked preserved");
assert.match(sidebar, /trackEvent\("brand_library_menu_clicked"/, "brand_library_menu_clicked preserved");
assert.match(sidebar, /trackEvent\("mcp_menu_clicked"/, "mcp_menu_clicked preserved");
assert.match(sidebar, /trackEvent\("first_clip_cta_clicked"/, "first_clip_cta_clicked preserved");

// ── 3. TopNav primary creation CTA + remove duplicate /docs ────────────────
assert.doesNotMatch(
  topNav,
  /href:\s*["']\/docs["']|href=["']\/docs["']|วิธีใช้งาน/,
  "TopNav removes the duplicate วิธีใช้งาน (/docs) link",
);
assert.match(
  topNav,
  /href="\/video-editor"[\s\S]*?สร้างคลิปใหม่/,
  "TopNav includes primary สร้างคลิปใหม่ CTA linking to /video-editor",
);
assert.match(
  topNav,
  /#8B66F8,#6C4CF4/,
  "TopNav CTA uses house violet gradient",
);
assert.match(
  topNav,
  /min-h-\[36px\][\s\S]*?sm:min-h-\[38px\]/,
  "TopNav CTA maintains comfortable compact height",
);
assert.match(
  topNav,
  /!isOnVideoEditor/,
  "TopNav hides the creation CTA when already on /video-editor",
);

// ── 4. BottomTabs elevated center creation pill ────────────────────────────
assert.match(
  bottomTabs,
  /title:\s*"สร้างคลิป",\s*href:\s*"\/video-editor"[\s\S]*?featured:\s*true/,
  "BottomTabs marks the center /video-editor tab as featured สร้างคลิป",
);
assert.match(
  bottomTabs,
  /#8B66F8,#6C4CF4/,
  "BottomTabs center creation pill uses house violet gradient",
);
assert.match(
  bottomTabs,
  /min-h-\[56px\]/,
  "BottomTabs preserves >=44px mobile touch targets",
);
assert.match(
  bottomTabs,
  /safe-area-inset-bottom/,
  "BottomTabs preserves iOS safe-area-inset-bottom padding",
);

// ── 5. /pricing ?cycle= pre-selection for HERO-111 checkout recovery ───────
assert.match(
  pricingPage,
  /cycle\?:\s*string/,
  "PricingPage searchParams accepts optional cycle query param",
);
assert.match(
  pricingPage,
  /cancelReturn\.period[\s\S]*?params\.cycle === "annual" \|\| params\.cycle === "monthly" \? params\.cycle : null/,
  "PricingPage falls back to whitelisted params.cycle when params.period is absent",
);
assert.match(
  pricingPage,
  /preferredPeriod=\{resolvedPreferredPeriod\}/,
  "PricingPage passes resolvedPreferredPeriod to PricingClient",
);

// Pure parity check for `?period=` + `?cycle=` fallback precedence
function resolvePreferredPeriod(params: { period?: string; cycle?: string }): "annual" | "monthly" | null {
  const fromPeriod = params.period === "annual" || params.period === "monthly" ? params.period : undefined;
  return fromPeriod ?? (params.cycle === "annual" || params.cycle === "monthly" ? params.cycle : null);
}
assert.equal(resolvePreferredPeriod({ cycle: "annual" }), "annual", "HERO-111 checkout_recovery ?cycle=annual resolves to annual");
assert.equal(resolvePreferredPeriod({ cycle: "monthly" }), "monthly", "?cycle=monthly resolves to monthly");
assert.equal(resolvePreferredPeriod({ period: "monthly", cycle: "annual" }), "monthly", "explicit ?period= takes precedence over ?cycle=");
assert.equal(resolvePreferredPeriod({ cycle: "quarterly" }), null, "invalid ?cycle= value is rejected");

console.log(
  "verify-hero-113-ux-nav-pricing: PASS — MobileSidebar auto-close & 44px target, Sidebar /pricing CTAs & grouping, TopNav CTA, BottomTabs center pill, /pricing ?cycle= preselect",
);
