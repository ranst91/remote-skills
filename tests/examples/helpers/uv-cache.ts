import { posix, win32 } from "node:path";

export const uvCacheDirectoryArguments = ["cache", "dir", "--color", "never", "--no-config"];

export function uvCacheQueryEnvironment(environment: NodeJS.ProcessEnv) {
  const queryEnvironment = { ...environment };
  delete queryEnvironment.XDG_CACHE_HOME;
  return queryEnvironment;
}

function hasControlCharacter(value: string) {
  return [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
}

export function parseUvCacheDirectory(
  output: string,
  { platform = process.platform }: { platform?: NodeJS.Platform } = {},
) {
  const lineEnding = output.endsWith("\r\n") ? "\r\n" : output.endsWith("\n") ? "\n" : "";
  const cache = output.slice(0, output.length - lineEnding.length);
  const path = platform === "win32" ? win32 : posix;
  if (
    lineEnding.length === 0 ||
    cache.length === 0 ||
    hasControlCharacter(cache) ||
    !path.isAbsolute(cache)
  ) {
    throw new Error("uv cache directory output was not one plain absolute path");
  }
  return cache;
}
