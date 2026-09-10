// @ts-check

import type { FileHandle } from "node:fs/promises";
import { open } from "node:fs/promises";

/** @param {string} directory */
export async function syncDirectory(directory: string) {
  let handle: FileHandle | undefined;
  try {
    handle = await open(directory, "r");
    await handle.sync();
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      ["EINVAL", "ENOTSUP", "EISDIR", "EPERM"].includes(String(error.code))
    )
      return;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
