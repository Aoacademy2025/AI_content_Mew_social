export type GrowthOpportunityLevel = "สูง" | "กลาง" | "ต่ำ";

export type RevenueGrowthOpportunity = {
  id: "broll-control" | "return-loop" | "face-lock" | "prepaid-renewal";
  rank: number;
  lane: "ทำก่อน" | "ปรับตอนนี้" | "ทดลองขาย";
  title: string;
  recommendation: string;
  evidence: string;
  revenueMove: string;
  metric: string;
  impact: GrowthOpportunityLevel;
  confidence: GrowthOpportunityLevel;
  effort: GrowthOpportunityLevel;
};

export type RevenueGrowthOpportunityPlan = {
  verdict: string;
  principle: string;
  opportunities: RevenueGrowthOpportunity[];
};

export function buildRevenueGrowthOpportunityPlan(input: {
  activeCreators: number;
  activePayingCustomers: number;
  videoCreators: number;
  imageCreators: number;
  prepaidMonthlyEquivalent: number;
  activeMonthlyValue: number;
  brollFeatureRequests: number;
  faceConsistencyRequests: number;
}): RevenueGrowthOpportunityPlan {
  const inactivePayers = Math.max(0, input.activePayingCustomers - input.activeCreators);
  const prepaidShare = input.activeMonthlyValue > 0
    ? Math.round((input.prepaidMonthlyEquivalent / input.activeMonthlyValue) * 100)
    : 0;
  const creatorBase = Math.max(1, input.activeCreators);
  const videoShare = Math.round((input.videoCreators / creatorBase) * 100);
  const imageShare = Math.round((input.imageCreators / creatorBase) * 100);
  const brollDemand = input.brollFeatureRequests > 0
    ? `พบ Feature request ${input.brollFeatureRequests} เคส`
    : "ยังไม่มีคำขอตรง ต้องทดสอบกับผู้ใช้ก่อน";
  const faceDemand = input.faceConsistencyRequests > 0
    ? `พบคำขอเรื่องความเหมือน ${input.faceConsistencyRequests} เคส`
    : "ยังไม่มีคำขอตรง จึงเป็นสมมติฐานที่ต้อง Pre-sell";

  return {
    verdict: input.brollFeatureRequests > 0
      ? "ทำ B-roll บน Timeline ก่อน แล้วเปิด Pre-sell ฟีเจอร์ Face Lock"
      : "แก้เส้นทางกลับมาสร้างก่อน แล้วทดสอบขาย B-roll และ Face Lock",
    principle: "งานแก้ Retention ช่วยรักษารายได้ แต่งานที่จะโตแบบก้าวกระโดดต้องเป็นความสามารถที่ขายเพิ่มหรือพาลูกค้าใหม่เข้ามาได้",
    opportunities: [
      {
        id: "broll-control",
        rank: 1,
        lane: "ทำก่อน",
        title: "B-roll ที่คุมได้บน Timeline",
        recommendation: "รวม Auto B-roll, ลากปรับช่วง, เปลี่ยนช็อต และสร้างใหม่เฉพาะจุดไว้ใน Flow เดียว",
        evidence: `${input.videoCreators}/${input.activeCreators} MAPC ทำวิดีโอ (${videoShare}%) · ${brollDemand}`,
        revenueMove: "ทำให้ผลลัพธ์ดูมืออาชีพเร็วขึ้น และใช้เป็นจุดขายของ PRO/BUSINESS",
        metric: "Video MAPC · Trial→Paid",
        impact: "สูง",
        confidence: input.brollFeatureRequests > 0 ? "สูง" : "กลาง",
        effort: "กลาง",
      },
      {
        id: "return-loop",
        rank: 2,
        lane: "ปรับตอนนี้",
        title: "กลับมาสร้างต่อใน 1 คลิก",
        recommendation: "เปิดงานล่าสุดพร้อม Next action และ Template ตาม Use case แทนการให้เริ่มใหม่ทุกครั้ง",
        evidence: `${inactivePayers}/${input.activePayingCustomers} ลูกค้าจ่ายจริงยังไม่สร้างงานสำเร็จใน 30 วัน`,
        revenueMove: "ลดการหายหลังจ่าย เพิ่มการใช้ซ้ำ และลดความเสี่ยงยกเลิก",
        metric: "MAPC · Repeat creation",
        impact: "สูง",
        confidence: "สูง",
        effort: "กลาง",
      },
      {
        id: "face-lock",
        rank: 3,
        lane: "ทดลองขาย",
        title: "Face Lock: คนเดิมทุกซีน",
        recommendation: "ให้ลูกค้าอัปโหลด Reference แล้วล็อกใบหน้า ตัวละคร และสไตล์ข้ามภาพกับ B-roll ทั้งโปรเจกต์",
        evidence: `${input.imageCreators}/${input.activeCreators} MAPC ใช้ภาพ (${imageShare}%) · ${faceDemand}`,
        revenueMove: "สร้างความต่างที่คู่แข่งเลียนแบบยาก และขายเป็นเครดิตเพิ่มหรือสิทธิ์ BUSINESS",
        metric: "Pre-sell · Credit revenue",
        impact: "สูง",
        confidence: input.faceConsistencyRequests > 0 ? "กลาง" : "ต่ำ",
        effort: "สูง",
      },
      {
        id: "prepaid-renewal",
        rank: 4,
        lane: "ปรับตอนนี้",
        title: "ต่ออายุจ่ายล่วงหน้าก่อนหมดสิทธิ์",
        recommendation: "เตือนก่อนหมดสิทธิ์ 30/14/3 วัน พร้อมลิงก์ต่ออายุในคลิกเดียวและข้อเสนอรายปี",
        evidence: `${prepaidShare}% ของฐานรายเดือนเป็นเงินจ่ายล่วงหน้าที่ไม่ต่ออายุเอง`,
        revenueMove: "ปิดรูรั่วรายได้ก่อนทุ่มงบหาลูกค้าใหม่",
        metric: "Renewal rate · Cash retained",
        impact: prepaidShare >= 25 ? "สูง" : "กลาง",
        confidence: "สูง",
        effort: "ต่ำ",
      },
    ],
  };
}
