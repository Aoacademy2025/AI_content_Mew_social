import { prisma } from "../../src/lib/prisma";

// PRISMA_SLOW_QUERY_MS=0 is the off switch: the handler must never even be attached, so no
// [prisma-slow-query] line can appear no matter how long a query takes.
async function main() {
  await prisma.user.count();
  await new Promise((resolve) => setTimeout(resolve, 600));
  await prisma.$disconnect();
  console.log("prisma-slow-query-disabled: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
