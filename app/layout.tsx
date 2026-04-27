import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "AI Micro-Zone Disaster Intelligence",
  description: "Micro-zone disaster intelligence and resource dispatcher"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body suppressHydrationWarning>{children}</body>
    </html>
  );
}
