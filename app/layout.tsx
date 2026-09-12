import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Home Base",
  description: "A small authenticated room for Lana's agents.",
  icons: { icon: "/favicon.svg" },
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
