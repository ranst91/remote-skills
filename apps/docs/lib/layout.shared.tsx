import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";

export function baseOptions(): BaseLayoutProps {
  return {
    searchToggle: { enabled: false },
    nav: {
      url: "/docs",
      title: (
        <span className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            RS
          </span>
          <span>Remote Skills</span>
        </span>
      ),
    },
    githubUrl: "https://github.com/ranst91/remote-skills",
    links: [],
  };
}
