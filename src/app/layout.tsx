import type { Metadata } from "next";
import type { ReactNode } from "react";
import { cookies } from "next/headers";
import "./globals.css";

export const metadata: Metadata = {
  title: "Marketing Intelligence",
  description: "Marketing analytics for business owners and agencies (Phase 1, local development build).",
  robots: { index: false, follow: false },
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  // Appearance chosen in Account settings (cookie, so the page is drawn in the right theme at once).
  const theme = (await cookies()).get("theme")?.value;
  return (
    <html lang="en" className={theme === "dark" ? "dark" : theme === "system" ? "theme-system" : undefined}>
      <body className="min-h-screen font-sans antialiased">{children}</body>
    </html>
  );
}
