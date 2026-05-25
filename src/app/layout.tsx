import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import { Providers } from "@/components/providers";
import { Toaster } from "sonner";
import { RouteProgress } from "@/components/layout/route-progress";

const inter = Inter({ subsets: ["latin"] });

// Thai + decorative Google Fonts for subtitle editor
const GOOGLE_FONTS_URL =
  "https://fonts.googleapis.com/css2?family=Mitr:wght@400;600;700&family=Kanit:wght@400;600;700&family=Sarabun:wght@400;600;700&family=Prompt:wght@400;600;700&family=Noto+Sans+Thai:wght@400;600;700&family=IBM+Plex+Sans+Thai:wght@400;600;700&family=Chakra+Petch:wght@400;600;700&family=Chonburi&family=Fahkwang:wght@400;600;700&family=Itim&family=Sriracha&family=Bangers&family=Bebas+Neue&family=Oswald:wght@400;600;700&family=Anton&family=Righteous&family=Playfair+Display:wght@700&family=Pacifico&family=Lobster&display=swap";

export const metadata: Metadata = {
  title: "Hero AI Creator Studio",
  description: "AI-Powered Content, Built for Creators.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="th" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link href={GOOGLE_FONTS_URL} rel="stylesheet" />
      </head>
      <body className={inter.className}>
        <Providers>
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
  );
}
