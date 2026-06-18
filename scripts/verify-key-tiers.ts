import { KEY_TIERS, computeKeyStatus, isTier1Complete, type KeyId } from "../src/lib/key-tiers";

let failures = 0;
function check(name: string, cond: boolean) {
  console.log(`${cond ? "✓" : "✗"} ${name}`);
  if (!cond) failures++;
}

// every key has non-empty label, desc, getUrl
check("all keys have label/desc/getUrl", KEY_TIERS.every(k => k.label && k.desc && k.getUrl));
// required tier is exactly gemini + pexels + pixabay; advanced is elevenlabs + heygen
const required = KEY_TIERS.filter(k => k.tier === "required").map(k => k.id).sort();
const advanced = KEY_TIERS.filter(k => k.tier === "advanced").map(k => k.id).sort();
check("required = gemini,pexels,pixabay", JSON.stringify(required) === JSON.stringify(["gemini","pexels","pixabay"]));
check("advanced = elevenlabs,heygen", JSON.stringify(advanced) === JSON.stringify(["elevenlabs","heygen"]));
// advanced keys carry a skipNote ("ไม่ใส่ก็ใช้งานได้")
check("advanced keys have skipNote", KEY_TIERS.filter(k => k.tier === "advanced").every(k => !!k.skipNote));

// tier1Complete logic: needs gemini AND (pexels OR pixabay)
check("tier1 false when no gemini", isTier1Complete({ gemini: false, pexels: true, pixabay: true }) === false);
check("tier1 false when no stock", isTier1Complete({ gemini: true, pexels: false, pixabay: false }) === false);
check("tier1 true gemini+pexels", isTier1Complete({ gemini: true, pexels: true, pixabay: false }) === true);
check("tier1 true gemini+pixabay", isTier1Complete({ gemini: true, pexels: false, pixabay: true }) === true);

// computeKeyStatus fills all ids + tier1Complete
const st = computeKeyStatus({ gemini: true, pixabay: true });
check("computeKeyStatus defaults missing to false", st.pexels === false && st.elevenlabs === false && st.heygen === false);
check("computeKeyStatus tier1Complete true", st.tier1Complete === true);

console.log(failures === 0 ? "\n✅ ALL KEY-TIERS CHECKS PASSED" : `\n❌ ${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
