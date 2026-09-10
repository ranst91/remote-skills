import { notFound } from "next/navigation";
import { DocsBody, DocsDescription, DocsPage, DocsTitle } from "fumadocs-ui/layouts/docs/page";

import { source } from "@/lib/source";
import { getMDXComponents } from "@/mdx-components";

export default async function DocumentationPage(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  const Content = page.data.body;
  const introduction = !slug || slug.length === 0;

  return (
    <DocsPage
      toc={page.data.toc}
      full={introduction}
      className={introduction ? "docs-page intro-page" : "docs-page"}
      breadcrumb={{ enabled: false }}
      tableOfContentPopover={{ enabled: !introduction }}
      footer={{
        className: "page-footer",
        ...(slug?.[0] === "quickstart"
          ? {
              items: {
                previous: { name: "Introduction", url: "/docs" },
                next: { name: "Prepare a skill", url: "/docs/publisher" },
              },
            }
          : {}),
      }}
    >
      <div className="page-heading">
        <p className="page-label">{introduction ? "Documentation" : "Remote Skills"}</p>
        <DocsTitle>
          {introduction
            ? page.data.description?.split(". ").map((line, index, lines) => (
                <span key={line}>
                  {line}
                  {index < lines.length - 1 ? "." : ""}
                </span>
              ))
            : page.data.title}
        </DocsTitle>
        {!introduction && page.data.description ? (
          <DocsDescription>{page.data.description}</DocsDescription>
        ) : null}
      </div>
      <DocsBody>
        <Content components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}

export function generateStaticParams() {
  return source.generateParams();
}

export async function generateMetadata(props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const page = source.getPage(slug);
  if (!page) notFound();
  return { title: page.data.title, description: page.data.description };
}
