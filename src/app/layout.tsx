import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "MarketPilot · Crude Oil Mini", description: "Private CRUDEOILM decision journal and paper trading. Capital first." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en"><body>{children}</body></html>;
}
