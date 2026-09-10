import { pathToFileURL } from "node:url";

import { runRemoteSkills } from "./public-cli.ts";
import { startStaticOrigin } from "./static-host.ts";

export async function verifyPagesRoot(root: string) {
  const server = await startStaticOrigin({ root });
  try {
    await runRemoteSkills(["verify", server.origin], { inherit: true });
  } finally {
    await server.close();
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.argv[2];
  if (root === undefined) throw new Error("usage: node verify-pages-root.ts <dist-directory>");
  await verifyPagesRoot(root);
}
