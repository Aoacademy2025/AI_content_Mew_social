import { NextResponse } from "next/server";
import { getCurrentUser } from "@/lib/clerk-auth";
import { apiError } from "@/lib/api-error";

export async function POST(req: Request) {
  try {
    const authUser = await getCurrentUser();

    if (!authUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { provider, apiKey } = await req.json();

    if (!provider || !apiKey) {
      return NextResponse.json(
        { error: "Provider and API key are required" },
        { status: 400 }
      );
    }

    let valid = false;

    // Test API keys based on provider
    switch (provider) {
      case "heygen":
        valid = await testHeyGen(apiKey);
        break;
      case "elevenlabs":
        valid = await testElevenLabs(apiKey);
        break;
      default:
        return NextResponse.json(
          { error: "Invalid provider" },
          { status: 400 }
        );
    }

    return NextResponse.json({ valid });
  } catch (error) {
    return apiError({ route: "user/test-api-key", error });
  }
}

async function testHeyGen(apiKey: string): Promise<boolean> {
  try {
    // HeyGen API test endpoint (adjust based on actual API)
    const response = await fetch("https://api.heygen.com/v1/avatars", {
      headers: {
        "X-Api-Key": apiKey,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function testElevenLabs(apiKey: string): Promise<boolean> {
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/voices", {
      headers: {
        "xi-api-key": apiKey,
      },
    });
    return response.ok;
  } catch {
    return false;
  }
}
