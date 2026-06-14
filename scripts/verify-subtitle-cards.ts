//   DATABASE_URL="file:$(pwd)/prisma/dev.db" npx tsx scripts/verify-subtitle-cards.ts
import { cardsByWordCount, POSITION_TOP_PERCENT } from "../src/lib/mcp/orchestrator-steps";
let passed = 0; function assert(c: boolean, m: string){ if(!c){console.error("❌ "+m);process.exit(1);} console.log("✓ "+m); passed++; }
const words = [ {word:"a",startMs:0,endMs:100},{word:"b",startMs:100,endMs:200},{word:"c",startMs:200,endMs:300},{word:"d",startMs:300,endMs:400},{word:"e",startMs:400,endMs:500} ];
const c2 = cardsByWordCount(words, 2);
assert(c2.length === 3, "5 words / 2 per card = 3 cards");
assert(c2[0].text === "a b" && c2[0].startMs === 0 && c2[0].endMs === 200, "card 1 = first 2 words, spans their time");
assert(c2[2].text === "e" && c2[2].endMs === 500, "last card = remainder");
const c1 = cardsByWordCount(words, 1);
assert(c1.length === 5 && c1[0].text === "a", "1 word per card = 5 cards");
assert(POSITION_TOP_PERCENT.top < POSITION_TOP_PERCENT.middle && POSITION_TOP_PERCENT.middle < POSITION_TOP_PERCENT.bottom, "position map ordered top<middle<bottom");
console.log(`\n${passed} assertions passed ✅`);
