import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Analytics } from "@vercel/analytics/react";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Minesweeper — free classic game",
  description:
    "Play the classic Minesweeper game for free in your browser. Choose easy, medium, or hard — no downloads, no installs.",
  openGraph: {
    title: "Minesweeper — free classic game",
    description:
      "Play the classic Minesweeper game for free in your browser. Choose easy, medium, or hard — no downloads, no installs.",
    type: "website",
  },
  twitter: {
    card: "summary",
    title: "Minesweeper — free classic game",
    description:
      "Play the classic Minesweeper game for free in your browser. Choose easy, medium, or hard — no downloads, no installs.",
  },
  icons: {
    icon: "/favicon.ico",
  },
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable}`}>
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  );
}
