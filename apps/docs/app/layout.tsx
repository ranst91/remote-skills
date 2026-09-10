import "./global.css";

import type { Metadata } from "next";
import type { ReactNode } from "react";
import { RootProvider } from "fumadocs-ui/provider/next";

export const metadata: Metadata = {
  title: { default: "Remote Skills documentation", template: "%s · Remote Skills" },
  description: "Publish and consume verified Agent Skills from standards-compatible origins.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <RootProvider search={{ enabled: false }}>{children}</RootProvider>
      </body>
    </html>
  );
}
