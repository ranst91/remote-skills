import type { TestContext } from "node:test";

export function posixMutationProbe(context: TestContext, reason: string) {
  if (process.platform !== "win32") return false;
  context.skip(reason);
  return true;
}
