import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Remote Skills · Vercel AI SDK",
  description: "A chat using Vercel’s native skill loader with a remote source.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
