import { createHash } from "node:crypto";
import { homedir, platform as runtimePlatform } from "node:os";
import { isAbsolute, join, win32 } from "node:path";

import { CacheConfigurationError } from "./errors.ts";

type DefaultCacheDirectoryInput = {
  platform?: NodeJS.Platform;
  home?: string;
  env?: NodeJS.ProcessEnv;
};

export function sanitizeCanonicalUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new CacheConfigurationError("canonicalUrl");
  }
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export function canonicalOriginIdentifier(canonicalUrl: string, confirmedScope?: string): string {
  const sanitizedUrl = sanitizeCanonicalUrl(canonicalUrl);
  if (
    confirmedScope !== undefined &&
    (confirmedScope.length < 1 ||
      confirmedScope.length > 128 ||
      confirmedScope.includes(",") ||
      !/^[\x21-\x7e]+$/u.test(confirmedScope))
  ) {
    throw new CacheConfigurationError("confirmedScope");
  }
  const identity =
    confirmedScope === undefined
      ? sanitizedUrl
      : `${sanitizedUrl}\nremote-skills-scope:${confirmedScope}`;
  return createHash("sha256").update(identity, "utf8").digest("hex");
}

export function catalogMutationDigest(catalogIdentifier: string): string {
  if (!/^[0-9a-f]{64}$/u.test(catalogIdentifier)) {
    throw new CacheConfigurationError("catalogIdentifier");
  }
  const identity = `remote-skills-catalog-mutation-v1\n${catalogIdentifier}\n`;
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

export function catalogAbsenceGeneration(catalogIdentifier: string, epoch: number): string {
  if (!/^[0-9a-f]{64}$/u.test(catalogIdentifier)) {
    throw new CacheConfigurationError("catalogIdentifier");
  }
  if (!Number.isSafeInteger(epoch) || epoch < 0) {
    throw new CacheConfigurationError("catalogGenerationEpoch");
  }
  const identity = `remote-skills-catalog-absence-v1\n${catalogIdentifier}\n${epoch}\n`;
  return `sha256:${createHash("sha256").update(identity, "utf8").digest("hex")}`;
}

export function defaultCacheDirectory(input: DefaultCacheDirectoryInput = {}): string {
  const currentPlatform = input.platform ?? runtimePlatform();
  const env = input.env ?? process.env;
  const home = input.home ?? homedir();

  const requireAbsoluteHome = (): string => {
    const absolute = currentPlatform === "win32" ? win32.isAbsolute(home) : isAbsolute(home);
    if (home.length === 0 || !absolute) throw new CacheConfigurationError("home");
    return home;
  };

  if (currentPlatform === "darwin") {
    return join(requireAbsoluteHome(), "Library", "Caches", "remote-skills");
  }
  if (currentPlatform === "win32") {
    const localAppData = env.LOCALAPPDATA;
    const base =
      localAppData !== undefined && localAppData.length > 0 && win32.isAbsolute(localAppData)
        ? localAppData
        : win32.join(requireAbsoluteHome(), "AppData", "Local");
    return win32.join(base, "remote-skills");
  }
  const xdgCacheHome = env.XDG_CACHE_HOME;
  const base =
    xdgCacheHome !== undefined && xdgCacheHome.length > 0 && isAbsolute(xdgCacheHome)
      ? xdgCacheHome
      : join(requireAbsoluteHome(), ".cache");
  return join(base, "remote-skills");
}
