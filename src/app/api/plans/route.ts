import { NextResponse } from "next/server";
import { getPlanConfig } from "@/lib/plan-config";

export async function GET() {
  return NextResponse.json(await getPlanConfig());
}
