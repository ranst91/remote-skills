import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    searchToggle: { enabled: false },
    nav: {
      title: (
        <span className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            RS
          </span>
          <span>Remote Skills</span>
        </span>
      ),
    },
    links: [
      { text: "Start", url: "/docs" },
      { text: "Hosting", url: "/docs/hosting/archive-to-origin" },
      { text: "API", url: "/docs/api-reference" },
    ],
  };
}
