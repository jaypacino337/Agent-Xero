import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, VT323 } from "next/font/google";
import { ScrollProgress } from "@/components/fx";
import { site } from "@/lib/site";
import "./globals.css";

const mono = JetBrains_Mono({ subsets: ["latin"], variable: "--font-jbmono" });
const vt = VT323({ subsets: ["latin"], weight: "400", variable: "--font-vt" });

export const metadata: Metadata = {
  metadataBase: new URL(site.url),
  title: `${site.name} ($${site.ticker}) // live terminal`,
  description: site.description,
  icons: { icon: "/icon.svg" },
  openGraph: { title: `${site.name} ($${site.ticker})`, description: site.description, images: ["/og.svg"], type: "website" },
  twitter: { card: "summary_large_image", title: `${site.name} ($${site.ticker})`, description: site.description, images: ["/og.svg"] },
};

export const viewport: Viewport = { themeColor: "#040705" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${mono.variable} ${vt.variable}`}>
      <body className="crt noise min-h-svh overflow-x-clip bg-bg font-mono text-fg antialiased">
        <ScrollProgress />
        <div aria-hidden className="crt-vignette pointer-events-none fixed inset-0 z-[59]" />
        <div aria-hidden className="pointer-events-none fixed inset-0 z-[58] overflow-hidden">
          <div className="animate-sweep h-24 w-full bg-gradient-to-b from-transparent via-brand/[0.035] to-transparent" />
        </div>
        {children}
      </body>
    </html>
  );
}
