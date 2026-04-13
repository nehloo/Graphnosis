import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Link from "next/link";
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
  title: "graphAI — Dual-Graph Knowledge System",
  description: "Transform raw files into AI-optimized directed & undirected graph representations",
};

const navItems = [
  { href: "/", label: "Dashboard" },
  { href: "/examples", label: "Examples" },
  { href: "/graph", label: "Graph" },
  { href: "/chat", label: "Chat" },
  { href: "/correct", label: "Correct" },
  { href: "/giki", label: "Giki" },
  { href: "/audit", label: "Audit" },
  { href: "/view-gai", label: "View .gai" },
  { href: "/longmemeval", label: "LongMemEval" },
];

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased dark`}
    >
      <body className="min-h-full flex flex-col bg-background text-foreground font-sans">
        <header className="border-b border-border bg-surface">
          <div className="max-w-7xl mx-auto px-4 h-14 flex items-center justify-between">
            <Link href="/" className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-md bg-accent flex items-center justify-center text-white text-xs font-bold">
                G
              </div>
              <span className="font-semibold text-sm tracking-tight">graphAI</span>
            </Link>
            <nav className="flex gap-1">
              {navItems.map((item) => (
                <Link
                  key={item.href}
                  href={item.href}
                  className="px-3 py-1.5 text-sm text-muted hover:text-foreground hover:bg-surface-2 rounded-md transition-colors"
                >
                  {item.label}
                </Link>
              ))}
            </nav>
          </div>
        </header>
        <main className="flex-1 max-w-7xl mx-auto w-full px-4 py-6">
          {children}
        </main>
        <footer className="border-t border-border bg-surface mt-8">
          <div className="max-w-7xl mx-auto px-4 py-6 space-y-2">
            <p className="text-xs text-muted leading-relaxed max-w-3xl">
              <strong className="text-foreground">graphAI</strong> explores a novel approach to AI knowledge representation: dual-graph structures (directed + undirected edges over the same node set) serialized in an AI-native binary format (.gai) — optimized for machine comprehension, not human readability. Graph construction costs $0 (pure JS, no embedding APIs). Human corrections, giki pages, and audit reports provide a full audit trail.
            </p>
            <div className="flex items-center gap-3 text-xs text-muted">
              <a
                href="https://github.com/nehloo/graphAI"
                target="_blank"
                rel="noopener noreferrer"
                className="hover:text-foreground transition-colors"
              >
                GitHub
              </a>
              <span className="text-border">|</span>
              <span>Created by Nelu Lazar</span>
              <span className="text-border">|</span>
              <span>MIT License</span>
            </div>
          </div>
        </footer>
      </body>
    </html>
  );
}
