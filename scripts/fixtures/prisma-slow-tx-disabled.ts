import { prisma } from "../../src/lib/prisma";

async function main() {
  await prisma.$transaction(async (tx) => {
    await tx.user.count();
    await new Promise((resolve) => setTimeout(resolve, 1_100));
  });
  await prisma.$disconnect();
  console.log("prisma-slow-tx-disabled: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
