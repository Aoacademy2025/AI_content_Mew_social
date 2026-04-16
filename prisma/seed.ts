import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";

const prisma = new PrismaClient();

async function main() {
  console.log("Start seeding...");

  // Create admin user
  const adminPassword = await bcrypt.hash("admin123", 10);
  const admin = await prisma.user.upsert({
    where: { email: "admin@test.com" },
    update: {},
    create: {
      email: "admin@test.com",
      name: "Admin User",
      password: adminPassword,
      role: "ADMIN",
      plan: "PRO",
      usageLimit: 999999,
      // Admin has all API keys configured
      openaiKey: Buffer.from("test-openai-admin-key").toString("base64"),
      heygenKey: Buffer.from("test-heygen-admin-key").toString("base64"),
      elevenlabsKey: Buffer.from("test-elevenlabs-admin-key").toString(
        "base64"
      ),
    },
  });

  // Create FREE plan user
  const userPassword = await bcrypt.hash("password123", 10);
  const user = await prisma.user.upsert({
    where: { email: "user@test.com" },
    update: {},
    create: {
      email: "user@test.com",
      name: "Free User",
      password: userPassword,
      role: "USER",
      plan: "FREE",
      usageLimit: 10,
      // FREE users don't have API keys - use server's key
    },
  });

  // Create PRO plan user
  const proPassword = await bcrypt.hash("password123", 10);
  const proUser = await prisma.user.upsert({
    where: { email: "pro@test.com" },
    update: {},
    create: {
      email: "pro@test.com",
      name: "Pro User",
      password: proPassword,
      role: "USER",
      plan: "PRO",
      usageLimit: 999999,
      // PRO users have all API keys configured
      openaiKey: Buffer.from("test-openai-pro-key").toString("base64"),
      heygenKey: Buffer.from("test-heygen-pro-key").toString("base64"),
      elevenlabsKey: Buffer.from("test-elevenlabs-pro-key").toString("base64"),
    },
  });

  // Create sample styles
  const styles = await Promise.all([
    prisma.style.upsert({
      where: { id: "style-1" },
      update: {},
      create: {
        id: "style-1",
        name: "สไตล์สบายๆ",
        sampleText: "วันนี้อากาศดีมาก ไปเที่ยวกันเถอะ!",
        instructionPrompt:
          "เขียนในสไตล์สบายๆ เป็นกันเอง ใช้ภาษาง่ายๆ เหมือนคุยกับเพื่อน",
        userId: admin.id,
      },
    }),
    prisma.style.upsert({
      where: { id: "style-2" },
      update: {},
      create: {
        id: "style-2",
        name: "สไตล์มืออาชีพ",
        sampleText:
          "การวางแผนการตลาดดิจิทัลที่มีประสิทธิภาพเป็นสิ่งสำคัญสำหรับธุรกิจสมัยใหม่",
        instructionPrompt:
          "เขียนในสไตล์มืออาชีพ ใช้ภาษาที่เป็นทางการ มีข้อมูลชัดเจน น่าเชื่อถือ",
        userId: admin.id,
      },
    }),
    prisma.style.upsert({
      where: { id: "style-3" },
      update: {},
      create: {
        id: "style-3",
        name: "สไตล์ฮาๆ",
        sampleText: "555+ อย่างฮาเลย แบบว่าฮามากกกก 😂",
        instructionPrompt:
          "เขียนในสไตล์ตลกขบขัน ใช้อิโมจิ มีมส์ สแลง ให้อารมณ์ขัน",
        userId: admin.id,
      },
    }),
  ]);

  // Create sample contents
  const contents = await Promise.all([
    prisma.content.create({
      data: {
        sourceText: "วันนี้ผมได้เรียนรู้เกี่ยวกับ AI และเทคโนโลยี Machine Learning มันน่าสนใจมาก",
        styleId: styles[0].id,
        language: "TH",
        headline: "เรียนรู้ AI ง่ายๆ",
        subheadline: "เทคโนโลยีที่เปลี่ยนโลก",
        body: "วันนี้ผมได้เรียนรู้เกี่ยวกับ AI และเทคโนโลยี Machine Learning มันน่าสนใจมากครับ",
        hashtags: "#AI #MachineLearning #เทคโนโลยี",
        userId: admin.id,
      },
    }),
    prisma.content.create({
      data: {
        sourceText: "เคล็ดลับการทำการตลาดออนไลน์ให้ประสบความสำเร็จ",
        styleId: styles[1].id,
        language: "TH",
        headline: "การตลาดออนไลน์ 101",
        subheadline: "กลยุทธ์สำหรับธุรกิจยุคใหม่",
        body: "เคล็ดลับการทำการตลาดออนไลน์ให้ประสบความสำเร็จสำหรับธุรกิจสมัยใหม่",
        hashtags: "#การตลาด #ธุรกิจออนไลน์ #DigitalMarketing",
        userId: admin.id,
      },
    }),
    prisma.content.create({
      data: {
        sourceText: "แมวของผมชอบนอนทั้งวัน ตื่นมาก็แค่กิน แล้วก็นอนต่อ",
        styleId: styles[2].id,
        language: "TH",
        headline: "ชีวิตของแมวผม 😺",
        subheadline: "นอน กิน นอน ซ้ำ 555+",
        body: "แมวของผมชอบนอนทั้งวัน ตื่นมาก็แค่กิน แล้วก็นอนต่อ อิจฉาชีวิตเค้าจัง 😂",
        hashtags: "#แมว #ชีวิตสบายๆ #CatLife",
        userId: user.id,
      },
    }),
    prisma.content.create({
      data: {
        sourceText: "เทคนิคการถ่ายภาพสำหรับมือใหม่",
        styleId: styles[0].id,
        language: "TH",
        headline: "เริ่มต้นถ่ายภาพ",
        subheadline: "สำหรับมือใหม่หัดถ่าย",
        body: "เทคนิคการถ่ายภาพสำหรับมือใหม่ ไม่ยาก เริ่มได้เลย!",
        hashtags: "#ถ่ายภาพ #Photography #มือใหม่",
        userId: user.id,
      },
    }),
    prisma.content.create({
      data: {
        sourceText: "10 ร้านอาหารเด็ดในกรุงเทพที่ต้องลอง",
        styleId: styles[2].id,
        language: "TH",
        headline: "กินเที่ยวกรุงเทพ 🍜",
        subheadline: "10 ร้านเด็ดห้ามพลาด!",
        body: "10 ร้านอาหารเด็ดในกรุงเทพที่ต้องลอง อร่อยมากกก! 😋",
        hashtags: "#อาหาร #กรุงเทพ #FoodReview",
        userId: user.id,
      },
    }),
  ]);

  console.log("Seeding finished.");
  console.log(`Created users:`);
  console.log(`  - Admin: ${admin.email} (password: admin123)`);
  console.log(`  - FREE User: ${user.email} (password: password123)`);
  console.log(`  - PRO User: ${proUser.email} (password: password123)`);
  console.log(`Created ${styles.length} styles`);
  console.log(`Created ${contents.length} contents`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
