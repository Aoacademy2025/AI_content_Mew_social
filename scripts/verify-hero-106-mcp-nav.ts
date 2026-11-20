import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(__dirname, "..");

const mcpPagePath = path.join(REPO_ROOT, "src/app/(dashboard)/mcp/page.tsx");
assert.ok(existsSync(mcpPagePath), "/mcp route page.tsx exists");

const sidebarSource = readFileSync(
  path.join(REPO_ROOT, "src/components/layout/sidebar.tsx"),
  "utf8",
);
const settingsSource = readFileSync(
  path.join(REPO_ROOT, "src/app/(dashboard)/settings/page.tsx"),
  "utf8",
);
const mcpSettingsSource = readFileSync(
  path.join(REPO_ROOT, "src/components/settings/mcp-access-settings.tsx"),
  "utf8",
);
const telemetryProviderSource = readFileSync(
  path.join(REPO_ROOT, "src/components/telemetry/telemetry-provider.tsx"),
  "utf8",
);

const userNavStart = sidebarSource.indexOf("const userNavItems: SidebarNavItem[] = [");
const userNavEnd = sidebarSource.indexOf("\n];", userNavStart);
const userNavBlock = sidebarSource.slice(userNavStart, userNavEnd);
assert.match(userNavBlock, /href:\s*"\/mcp"/, "userNavItems links to /mcp");

const adminStudioStart = sidebarSource.indexOf("const adminStudioItems: SidebarNavItem[] = [");
const adminStudioEnd = sidebarSource.indexOf("\n];", adminStudioStart);
const adminStudioBlock = sidebarSource.slice(adminStudioStart, adminStudioEnd);
assert.match(adminStudioBlock, /href:\s*"\/mcp"/, "adminStudioItems links to /mcp");

assert.match(sidebarSource, /trackEvent\("mcp_menu_clicked"/, "sidebar emits mcp_menu_clicked telemetry");
assert.match(settingsSource, /href="\/mcp"/, "Settings MCP tab links to /mcp");
assert.match(
  mcpSettingsSource,
  /event:\s*"mcp_prompt_pack_copied"/,
  "Creator Prompt Pack copy emits mcp_prompt_pack_copied telemetry",
);
assert.match(
  mcpSettingsSource,
  /event:\s*"mcp_config_copied"/,
  "1-click MCP config copy emits mcp_config_copied telemetry",
);
assert.match(
  telemetryProviderSource,
  /trackEvent\("page_viewed"/,
  "global TelemetryProvider tracks page_viewed on dashboard routes including /mcp",
);

console.log(
  "verify-hero-106-mcp-nav: PASS — /mcp wired in user/admin sidebar and Settings tab with click/copy telemetry",
);
