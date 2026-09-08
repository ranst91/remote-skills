import llmsPages from "@/lib/llms-pages.json";
import { source } from "@/lib/source";

export function getCanonicalPage(slug: string) {
  return source.getPage(slug === "index" ? undefined : slug.split("/"));
}

export function getMarkdownRoute(slug: string) {
  return `/docs/${slug}.md`;
}

export function generateMarkdownParams() {
  return source.generateParams().map(({ slug }) => ({ slug: slug ?? ["index"] }));
}

export function withoutFrontmatter(markdown: string) {
  const match = /^---\r?\n[\s\S]*?\r?\n---\r?\n/u.exec(markdown);
  if (!match) throw new Error("Canonical documentation page is missing YAML frontmatter");
  return markdown.slice(match[0].length).trim();
}

export function buildLlmsIndex() {
  const lines = [
    "# Remote Skills",
    "",
    "> Vendor-neutral tooling for publishing standard Agent Skills as static discovery origins and consuming digest-verified, immutable snapshots from TypeScript or Python.",
    "",
    "Remote Skills uses Agent Skills and Cloudflare Agent Skills Discovery v0.2.0. The linked pages are the canonical documentation in plain Markdown.",
  ];

  for (const section of llmsPages) {
    lines.push("", `## ${section.title}`, "");
    for (const slug of section.pages) {
      const page = getCanonicalPage(slug);
      if (!page) throw new Error(`Canonical documentation page not found: ${slug}`);
      lines.push(`- [${page.data.title}](${getMarkdownRoute(slug)}): ${page.data.description}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
