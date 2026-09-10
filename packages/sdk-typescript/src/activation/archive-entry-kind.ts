export function classifyZipEntryKind(
  unixType: number,
  hasDirectorySuffix: boolean,
): "regular" | "directory" | undefined {
  // Validate the declaration before applying the ZIP directory-name convention.
  if (unixType !== 0 && unixType !== 0x4000 && unixType !== 0x8000) return undefined;
  if (unixType === 0x8000 && hasDirectorySuffix) return undefined;
  return hasDirectorySuffix || unixType === 0x4000 ? "directory" : "regular";
}
