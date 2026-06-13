// DEV ONLY: mint a PAT for an existing user by email (uses the dev DATABASE_URL from .env).
// Usage: npx tsx scripts/mint-dev-mcp-token.ts you@example.com
import { prisma } from "../src/lib/prisma";
import { createMcpToken } from "../src/lib/mcp/token";

async function main() {
  const email = process.argv[2];
  if (!email) { console.error("usage: tsx scripts/mint-dev-mcp-token.ts <email>"); process.exit(1); }
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) { console.error("no user with email " + email); process.exit(1); }
  const { token } = await createMcpToken(user.id, "dev-cli");
  console.log(token);
  await prisma.$disconnect();
}
main().catch(async (e) => { console.error(e); await prisma.$disconnect(); process.exit(1); });
