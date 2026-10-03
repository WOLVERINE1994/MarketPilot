import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "MarketPilot · Crude Oil Mini", description: "Private CRUDEOILM decision journal and paper trading. Capital first." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en">
    {/* Grammarly can add attributes to body before hydration. This is scoped to
        that element; hydration warnings inside the dashboard remain enabled. */}
    <body suppressHydrationWarning>{children}</body>
  </html>;
}
