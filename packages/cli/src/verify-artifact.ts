import { constants as bufferConstants } from "node:buffer";
import { Readable } from "node:stream";
import { createGunzip, inflateRawSync } from "node:zlib";

import { validateSkillMarkdown } from "@remote-skills/core/authoring";

import { ArchivePathTable } from "./verify-artifact-hierarchy.ts";
import { PublisherVerifyError } from "./verify-errors.ts";

const TAR_BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });

type ArtifactLimits = { files: number; fileBytes: number; extractedBytes: number };
type ExtractionState = { total: number; files: number };
type PendingFile = { name: string; size: number };

/** @param {string} code @param {string} limit @returns {never} */
function fail(code: string, limit = ""): never {
  throw new PublisherVerifyError(code, limit ? { limit } : {});
}

/** @param {Buffer} bytes @param {number} start @param {number} end */
function tarString(bytes: Buffer, start: number, end: number): string {
  const field = bytes.subarray(start, end);
  const nul = field.indexOf(0);
  if (nul >= 0 && field.subarray(nul + 1).some((byte) => byte !== 0)) fail("archive_unsafe");
  return decoder.decode(nul < 0 ? field : field.subarray(0, nul));
}

/** @param {Buffer} bytes @param {number} start @param {number} end */
function tarNumber(bytes: Buffer, start: number, end: number): number {
  const field = bytes.subarray(start, end);
  if ((field[0] ?? 0) & 0x80) fail("archive_unsafe");
  const value = field
    .toString("ascii")
    .replace(/[\0 ]+$/u, "")
    .trimStart();
  if (!/^[0-7]+$/u.test(value)) fail("archive_unsafe");
  const number = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(number)) fail("limit_exceeded", "extractedBytes");
  return number;
}

/** @param {Buffer} header */
function validTarChecksum(header: Buffer): boolean {
  const expected = tarNumber(header, 148, 156);
  let actual = 0;
  for (let index = 0; index < header.length; index += 1)
    actual += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  return expected === actual;
}

/** @param {Map<string, Buffer>} files @param {string} skillName @param {string | undefined} expectedDescription */
function validateRootSkill(
  files: Map<string, Buffer>,
  skillName: string,
  expectedDescription: string | undefined,
): void {
  const skill = files.get("SKILL.md");
  if (!skill) fail("archive_unsafe");
  const parsed = validateSkillMarkdown(skill, { directoryName: skillName, sourcePath: "SKILL.md" });
  const skillMetadata = parsed.skill;
  if (!skillMetadata || parsed.diagnostics.some(({ severity }) => severity === "error"))
    fail("archive_unsafe");
  if (expectedDescription !== undefined && skillMetadata.description !== expectedDescription)
    fail("archive_unsafe");
}

function admitEntry(
  paths: ArchivePathTable,
  name: string,
  size: number,
  directory: boolean,
  limits: ArtifactLimits,
  state: ExtractionState,
): void {
  paths.admit(name, directory);
  if (directory) {
    if (size !== 0 || name === "SKILL.md") fail("archive_unsafe");
    return;
  }
  if (state.files >= limits.files) fail("limit_exceeded", "files");
  if (size > limits.fileBytes) fail("limit_exceeded", "fileBytes");
  state.total += size;
  if (!Number.isSafeInteger(state.total) || state.total > limits.extractedBytes)
    fail("limit_exceeded", "extractedBytes");
  state.files += 1;
}

async function* inflatedTarChunks(source: Uint8Array, maximum: number): AsyncGenerator<Buffer> {
  const input = Readable.from([source]);
  const gunzip = createGunzip();
  input.pipe(gunzip);
  let total = 0;
  try {
    for await (const value of gunzip) {
      const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
      const remaining = maximum - total;
      if (chunk.length > remaining) {
        if (remaining > 0) yield chunk.subarray(0, remaining);
        fail("limit_exceeded", "extractedBytes");
      }
      total += chunk.length;
      yield chunk;
    }
  } catch (error) {
    if (error instanceof PublisherVerifyError) throw error;
    fail("archive_unsafe");
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

async function tarPass(
  source: Uint8Array,
  limits: ArtifactLimits,
  expected?: readonly PendingFile[],
): Promise<{ pending: PendingFile[]; files: Map<string, Buffer> }> {
  const maximum = limits.extractedBytes + limits.files * TAR_BLOCK * 2 + 10_240;
  if (!Number.isSafeInteger(maximum) || maximum > bufferConstants.MAX_LENGTH)
    fail("limit_exceeded", "extractedBytes");
  const files = new Map<string, Buffer>();
  const pending: PendingFile[] = [];
  const paths = new ArchivePathTable();
  const state = { total: 0, files: 0 };
  const header = Buffer.alloc(TAR_BLOCK);
  let headerLength = 0;
  let inflated = 0;
  let dataRemaining = 0;
  let paddingRemaining = 0;
  let target: Buffer | undefined;
  let targetOffset = 0;
  let zeroBlocks = 0;
  let terminated = false;
  for await (const chunk of inflatedTarChunks(source, maximum)) {
    inflated += chunk.length;
    let cursor = 0;
    while (cursor < chunk.length) {
      if (terminated) {
        if (chunk.subarray(cursor).some((byte) => byte !== 0)) fail("archive_unsafe");
        break;
      }
      if (dataRemaining > 0) {
        const length = Math.min(dataRemaining, chunk.length - cursor);
        if (target !== undefined) {
          target.set(chunk.subarray(cursor, cursor + length), targetOffset);
          targetOffset += length;
        }
        dataRemaining -= length;
        cursor += length;
        continue;
      }
      if (paddingRemaining > 0) {
        const length = Math.min(paddingRemaining, chunk.length - cursor);
        paddingRemaining -= length;
        cursor += length;
        continue;
      }
      const length = Math.min(TAR_BLOCK - headerLength, chunk.length - cursor);
      header.set(chunk.subarray(cursor, cursor + length), headerLength);
      headerLength += length;
      cursor += length;
      if (headerLength !== TAR_BLOCK) continue;
      headerLength = 0;
      if (header.every((byte) => byte === 0)) {
        zeroBlocks += 1;
        terminated = zeroBlocks === 2;
        continue;
      }
      if (zeroBlocks !== 0 || !validTarChecksum(header)) fail("archive_unsafe");
      const type = header[156] ?? 0;
      const directory = type === 0x35;
      if (type !== 0 && type !== 0x30 && !directory) fail("archive_unsafe");
      let rawName: string;
      try {
        const suffix = tarString(header, 0, 100);
        const prefix = tarString(header, 345, 500);
        rawName = prefix ? `${prefix}/${suffix}` : suffix;
      } catch {
        fail("archive_unsafe");
      }
      const name = directory && rawName.endsWith("/") ? rawName.slice(0, -1) : rawName;
      const size = tarNumber(header, 124, 136);
      admitEntry(paths, name, size, directory, limits, state);
      target = undefined;
      targetOffset = 0;
      if (!directory) {
        if (expected !== undefined) {
          const planned = expected[pending.length];
          if (planned?.name !== name || planned.size !== size) fail("archive_unsafe");
          target = Buffer.alloc(size);
          files.set(name, target);
        }
        pending.push({ name, size });
      }
      dataRemaining = size;
      paddingRemaining = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size;
    }
  }
  if (
    !terminated ||
    headerLength !== 0 ||
    dataRemaining !== 0 ||
    paddingRemaining !== 0 ||
    inflated % TAR_BLOCK !== 0 ||
    !pending.some(({ name }) => name === "SKILL.md") ||
    (expected !== undefined && pending.length !== expected.length)
  )
    fail("archive_unsafe");
  return { pending, files };
}

async function validateTarGzip(
  source: Uint8Array,
  skillName: string,
  expectedDescription: string | undefined,
  limits: ArtifactLimits,
): Promise<void> {
  const compressed = new Uint8Array(source);
  const metadata = await tarPass(compressed, limits);
  const { files } = await tarPass(compressed, limits, metadata.pending);
  validateRootSkill(files, skillName, expectedDescription);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

/** @param {Uint8Array} bytes */
function crc32(bytes: Uint8Array): number {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) checksum = (checksum >>> 8) ^ (crcTable[(checksum ^ byte) & 0xff] ?? 0);
  return (checksum ^ 0xffff_ffff) >>> 0;
}

/** @param {Buffer} bytes */
function findEocd(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let index = bytes.length - 22; index >= earliest; index -= 1)
    if (
      bytes.readUInt32LE(index) === 0x0605_4b50 &&
      index + 22 + bytes.readUInt16LE(index + 20) === bytes.length
    )
      return index;
  return -1;
}

/** @param {Buffer} bytes @param {string} skillName @param {string | undefined} expectedDescription @param {{files: number, fileBytes: number, extractedBytes: number}} limits */
function validateZip(
  bytes: Buffer,
  skillName: string,
  expectedDescription: string | undefined,
  limits: ArtifactLimits,
): void {
  const eocd = findEocd(bytes);
  if (eocd < 0 || eocd + 22 + bytes.readUInt16LE(eocd + 20) !== bytes.length)
    fail("archive_unsafe");
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)
  )
    fail("archive_unsafe");
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralStart = bytes.readUInt32LE(eocd + 16);
  if (centralStart + centralSize !== eocd) fail("archive_unsafe");
  if (count > Math.floor(centralSize / 46)) fail("archive_unsafe");
  const entries: {
    name: string;
    size: number;
    method: number;
    checksum: number;
    dataStart: number;
    dataEnd: number;
    directory: boolean;
  }[] = [];
  const files = new Map<string, Buffer>();
  const paths = new ArchivePathTable();
  const state = { total: 0, files: 0 };
  let cursor = centralStart;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x0201_4b50) fail("archive_unsafe");
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38);
    const local = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > eocd || (flags & ~0x0808) !== 0 || ![0, 8].includes(method)) fail("archive_unsafe");
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      fail("archive_unsafe");
    }
    const madeBy = bytes.readUInt16LE(cursor + 4) >>> 8;
    const kind = madeBy === 3 ? (external >>> 16) & 0xf000 : 0;
    const isDirectory = name.endsWith("/") || kind === 0x4000;
    if (kind !== 0 && kind !== 0x8000 && kind !== 0x4000) fail("archive_unsafe");
    const normalizedName = isDirectory && name.endsWith("/") ? name.slice(0, -1) : name;
    admitEntry(paths, normalizedName, size, isDirectory, limits, state);
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x0403_4b50)
      fail("archive_unsafe");
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataEnd > centralStart ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      localNameLength !== nameLength ||
      !bytes
        .subarray(local + 30, local + 30 + nameLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    )
      fail("archive_unsafe");
    if (
      (flags & 0x08) === 0 &&
      (bytes.readUInt32LE(local + 14) !== checksum ||
        bytes.readUInt32LE(local + 18) !== compressedSize ||
        bytes.readUInt32LE(local + 22) !== size)
    )
      fail("archive_unsafe");
    if (method === 0 && compressedSize !== size) fail("archive_unsafe");
    entries.push({
      name: normalizedName,
      size,
      method,
      checksum,
      dataStart,
      dataEnd,
      directory: isDirectory,
    });
    cursor = next;
  }
  if (cursor !== eocd || !entries.some(({ name, directory }) => name === "SKILL.md" && !directory))
    fail("archive_unsafe");
  let remaining = limits.extractedBytes;
  for (const { name, size, method, checksum, dataStart, dataEnd, directory } of entries) {
    let contents: Buffer;
    try {
      contents =
        method === 0
          ? Buffer.from(bytes.subarray(dataStart, dataEnd))
          : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
              // zlib requires a positive cap, including for empty entries.
              maxOutputLength: Math.max(1, Math.min(size, limits.fileBytes, remaining)),
            });
    } catch {
      fail("archive_unsafe");
    }
    if (contents.length !== size || crc32(contents) !== checksum) fail("archive_unsafe");
    if (!directory) {
      remaining -= size;
      files.set(name, contents);
    }
  }
  validateRootSkill(files, skillName, expectedDescription);
}

/**
 * @param {Uint8Array} bytes
 * @param {{type: "skill-md" | "archive", url: URL, contentType?: string, skillName: string, expectedDescription?: string, limits: {files: number, fileBytes: number, extractedBytes: number}}} options
 */
export async function validateVerifiedArtifact(
  bytes: Uint8Array,
  options: {
    type: "skill-md" | "archive";
    url: URL;
    contentType?: string;
    skillName: string;
    expectedDescription?: string;
    limits: ArtifactLimits;
  },
): Promise<void> {
  if (options.type === "skill-md") {
    if (bytes.byteLength > options.limits.fileBytes) fail("limit_exceeded", "fileBytes");
    if (bytes.byteLength > options.limits.extractedBytes) fail("limit_exceeded", "extractedBytes");
    const parsed = validateSkillMarkdown(bytes, {
      directoryName: options.skillName,
      sourcePath: "SKILL.md",
    });
    const skillMetadata = parsed.skill;
    if (
      !skillMetadata ||
      parsed.diagnostics.some(({ severity }) => severity === "error") ||
      (options.expectedDescription !== undefined &&
        skillMetadata.description !== options.expectedDescription)
    )
      fail("catalog_invalid");
    return;
  }
  const contentType = options.contentType?.split(";", 1)[0]?.trim().toLowerCase();
  const pathname = options.url.pathname.toLowerCase();
  let format: "zip" | "tar.gz";
  if (contentType === "application/zip") format = "zip";
  else if (contentType === "application/gzip" || contentType === "application/x-gzip")
    format = "tar.gz";
  else if (pathname.endsWith(".tar.gz") || pathname.endsWith(".tgz")) format = "tar.gz";
  else if (pathname.endsWith(".zip")) format = "zip";
  else fail("artifact_unsupported");

  if (format === "zip")
    validateZip(Buffer.from(bytes), options.skillName, options.expectedDescription, options.limits);
  else await validateTarGzip(bytes, options.skillName, options.expectedDescription, options.limits);
}
