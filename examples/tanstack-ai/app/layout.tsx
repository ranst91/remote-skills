import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Remote Skills · TanStack AI",
  description: "A chat using TanStack AI’s native skill loader with a remote source.",
};
export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
