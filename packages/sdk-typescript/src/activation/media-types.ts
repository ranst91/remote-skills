import { extname } from "node:path";
const MEDIA_TYPES = new Map([
  [".md", "text/markdown"],
  [".txt", "text/plain"],
  [".json", "application/json"],
  [".yaml", "application/yaml"],
  [".yml", "application/yaml"],
  [".html", "text/html"],
  [".css", "text/css"],
  [".js", "text/javascript"],
  [".mjs", "text/javascript"],
  [".ts", "text/typescript"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".pdf", "application/pdf"],
]);
export function mediaTypeForPath(path: string): string {
  return MEDIA_TYPES.get(extname(path).toLowerCase()) ?? "application/octet-stream";
}
