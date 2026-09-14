import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Remote Skills · Mastra",
  description: "A chat using Mastra’s native skill loader with a remote source.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
