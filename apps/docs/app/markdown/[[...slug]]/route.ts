import {
  generateMarkdownParams,
  getCanonicalPage,
  withoutFrontmatter,
} from "@/lib/agent-accessibility";

export const dynamicParams = false;

export async function GET(_request: Request, props: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await props.params;
  const canonicalSlug = slug?.join("/") ?? "index";
  const page = getCanonicalPage(canonicalSlug);
  if (!page) return new Response("Documentation page not found.\n", { status: 404 });

  const body = withoutFrontmatter(await page.data.getText("raw"));
  const markdown = [`# ${page.data.title}`, "", page.data.description, "", body.trim(), ""].join(
    "\n",
  );
  return new Response(markdown, {
    headers: { "Content-Type": "text/markdown; charset=utf-8" },
  });
}

export function generateStaticParams() {
  return generateMarkdownParams();
}
