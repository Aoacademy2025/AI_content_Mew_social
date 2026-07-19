import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { ClerkProvider } from "@clerk/nextjs";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";
import { RouteProgress } from "@/components/layout/route-progress";
import { TelemetryProvider } from "@/components/telemetry/telemetry-provider";
import { StaleBundleGuard } from "@/components/stale-bundle-guard";

const inter = Inter({ subsets: ["latin"] });
const ICON_VERSION = "20260706-h";

// Thai + decorative Google Fonts for subtitle editor.
// Includes weights 700–900 because subtitle defaults to fontWeight=900 — without
// the heavy weights the browser fakes bold by stretching, which makes Thai glyphs
// look thinner/distorted in preview vs the burned MP4. Keep this in sync with the
// Remotion font URLs in src/remotion/* — both renderers must load the same files.
const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Mitr:wght@400;500;600;700&family=Kanit:wght@400;500;600;700;800;900&family=Sarabun:wght@400;500;600;700;800&family=Prompt:wght@400;500;600;700;800;900&family=Noto+Sans+Thai:wght@400;500;600;700;800;900&family=IBM+Plex+Sans+Thai:wght@400;500;600;700&family=Chakra+Petch:wght@400;500;600;700&family=Chonburi&family=Fahkwang:wght@400;500;600;700&family=K2D:wght@400;500;600;700;800&family=Charm:wght@400;700&family=Bai+Jamjuree:wght@400;600;700&family=Krub:wght@400;600;700&family=Pridi:wght@400;600;700&family=Itim&family=Sriracha&family=Bangers&family=Bebas+Neue&family=Oswald:wght@400;500;600;700&family=Anton&family=Righteous&family=Playfair+Display:wght@700;800;900&family=Pacifico&family=Lobster&display=swap";

export const metadata: Metadata = {
  title: "HERO AI Creator Studio",
  description: "AI-Powered Content, Built for Creators.",
  icons: {
    icon: [
      { url: `/icon.svg?v=${ICON_VERSION}`, type: "image/svg+xml" },
      { url: `/favicon.ico?v=${ICON_VERSION}`, sizes: "any" },
    ],
    apple: [{ url: `/apple-icon.png?v=${ICON_VERSION}`, sizes: "180x180", type: "image/png" }],
  },
};

// viewport-fit=cover so env(safe-area-inset-*) is non-zero on notched devices
// (the mobile bottom-tabs pad by safe-area-inset-bottom). Zoom + theme untouched.
export const viewport: Viewport = {
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider>
    <html lang="th" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={GOOGLE_FONTS_URL} rel="stylesheet" />
      </head>
      <body className={inter.className}>
        <Providers>
          <TelemetryProvider />
          <StaleBundleGuard />
          <RouteProgress />
          {children}
          <Toaster
            position="bottom-center"
            expand={false}
            visibleToasts={4}
            toastOptions={{
              style: {
                background: "rgba(18, 18, 26, 0.92)",
                backdropFilter: "blur(16px)",
                border: "1px solid rgba(255,255,255,0.08)",
                borderRadius: "14px",
                color: "#e2e8f0",
                fontSize: "13px",
                fontWeight: 500,
                padding: "12px 16px",
                boxShadow: "0 8px 32px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)",
                minWidth: "260px",
                maxWidth: "400px",
              },
              classNames: {
                success: "!border-emerald-500/30 !shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_16px_rgba(16,185,129,0.12)]",
                error:   "!border-red-500/30    !shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_16px_rgba(239,68,68,0.12)]",
                warning: "!border-amber-500/30  !shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_16px_rgba(245,158,11,0.12)]",
                info:    "!border-blue-500/30   !shadow-[0_8px_32px_rgba(0,0,0,0.5),0_0_16px_rgba(59,130,246,0.12)]",
              },
            }}
          />
        </Providers>
      </body>
    </html>
    </ClerkProvider>
  );
}
