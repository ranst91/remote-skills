import type { ReactNode } from "react";
import "./globals.css";

export const metadata = {
  title: "Remote Skills · LangChain family",
  description: "A chat using native LangChain-family skill loaders with a remote source.",
};

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
