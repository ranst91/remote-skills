import { Readable } from "node:stream";
import { createGunzip, inflateRawSync } from "node:zlib";

import type { CachedObject } from "../cache/types.ts";
import { RemoteSkillsError } from "../catalog/errors.ts";
import { classifyZipEntryKind } from "./archive-entry-kind.ts";
import { normalizedArchivePath } from "./paths.ts";
import type { NormalizedActivationLimits } from "./types.ts";

const TAR_BLOCK = 512;
const TAR_RECORD = 10_240;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function unsafe(path?: string): never {
  throw new RemoteSkillsError("archive_unsafe", path === undefined ? {} : { path });
}

function exceeded(limit: "archive_bytes" | "extracted_bytes" | "files" | "file_bytes"): never {
  throw new RemoteSkillsError("limit_exceeded", { limit });
}

function tarField(header: Buffer, start: number, end: number): Uint8Array {
  const field = header.subarray(start, end);
  const nul = field.indexOf(0);
  if (nul === -1) return field;
  if (field.subarray(nul + 1).some((byte) => byte !== 0)) unsafe();
  return field.subarray(0, nul);
}

function tarNumber(header: Buffer, start: number, end: number): number {
  const field = header.subarray(start, end);
  if ((field[0] ?? 0) >= 0x80) unsafe();
  const value = field.toString("ascii").replace(/[\0 ]+$/u, "");
  if (value === "") return 0;
  if (!/^[0-7]+$/u.test(value)) unsafe();
  const result = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(result)) unsafe();
  return result;
}

function requireTarChecksum(header: Buffer): void {
  const expected = tarNumber(header, 148, 156);
  let sum = 0;
  for (let index = 0; index < header.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (header[index] ?? 0);
  }
  if (sum !== expected) unsafe();
}

interface PendingFile {
  readonly path: string;
  readonly rawPath: string;
  readonly size: number;
}

function registerPath(
  rawPath: string,
  collisionKeys: Set<string>,
  normalizedPaths: Set<string>,
): string {
  const normalized = normalizedArchivePath(rawPath);
  if (normalized === null) unsafe(rawPath.includes("\0") ? undefined : rawPath);
  if (collisionKeys.has(normalized.collisionKey) || normalizedPaths.has(normalized.path)) {
    unsafe(rawPath);
  }
  collisionKeys.add(normalized.collisionKey);
  normalizedPaths.add(normalized.path);
  return normalized.path;
}

interface TarPass {
  readonly files: readonly PendingFile[];
  readonly contents: ReadonlyMap<string, Uint8Array>;
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
        exceeded("extracted_bytes");
      }
      total += chunk.length;
      yield chunk;
    }
  } catch (error) {
    if (error instanceof RemoteSkillsError) throw error;
    unsafe();
  } finally {
    input.destroy();
    gunzip.destroy();
  }
}

async function tarPass(
  source: Uint8Array,
  limits: NormalizedActivationLimits,
  expected?: readonly PendingFile[],
): Promise<TarPass> {
  const maximum = limits.extractedBytes + limits.files * (TAR_BLOCK * 2) + TAR_RECORD;
  if (!Number.isSafeInteger(maximum)) exceeded("extracted_bytes");
  const pending: PendingFile[] = [];
  const contents = new Map<string, Uint8Array>();
  const collisionKeys = new Set<string>();
  const normalizedPaths = new Set<string>();
  let total = 0;
  let inflated = 0;
  let headerLength = 0;
  const header = Buffer.alloc(TAR_BLOCK);
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
        if (chunk.subarray(cursor).some((byte) => byte !== 0)) unsafe();
        cursor = chunk.length;
        continue;
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
        if (zeroBlocks === 2) terminated = true;
        header.fill(0);
        continue;
      }
      if (zeroBlocks !== 0) unsafe();
      requireTarChecksum(header);
      let suffix: string;
      let prefix: string;
      try {
        suffix = utf8.decode(tarField(header, 0, 100));
        prefix = utf8.decode(tarField(header, 345, 500));
      } catch {
        unsafe();
      }
      const rawPath = prefix.length === 0 ? suffix : `${prefix}/${suffix}`;
      if (rawPath.includes("\0")) unsafe();
      const type = header[156] ?? 0;
      const size = tarNumber(header, 124, 136);
      const directory = type === 0x35;
      const regular = type === 0 || type === 0x30;
      const pathCandidate = directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
      const path = registerPath(pathCandidate, collisionKeys, normalizedPaths);
      if (!regular && !directory) unsafe(rawPath);
      if (directory && path === "SKILL.md") unsafe("SKILL.md");
      if (directory && size !== 0) unsafe(rawPath);
      target = undefined;
      targetOffset = 0;
      if (regular) {
        if (pending.length >= limits.files) exceeded("files");
        if (size > limits.fileBytes) exceeded("file_bytes");
        total += size;
        if (!Number.isSafeInteger(total) || total > limits.extractedBytes)
          exceeded("extracted_bytes");
        const metadata = { path, rawPath, size };
        if (expected !== undefined) {
          const planned = expected[pending.length];
          if (
            planned === undefined ||
            planned.path !== metadata.path ||
            planned.rawPath !== metadata.rawPath ||
            planned.size !== metadata.size
          )
            unsafe(rawPath);
          target = Buffer.alloc(size);
          contents.set(path, target);
        }
        pending.push(metadata);
      }
      dataRemaining = size;
      paddingRemaining = Math.ceil(size / TAR_BLOCK) * TAR_BLOCK - size;
      header.fill(0);
    }
  }
  if (
    !terminated ||
    headerLength !== 0 ||
    dataRemaining !== 0 ||
    paddingRemaining !== 0 ||
    inflated % TAR_BLOCK !== 0
  )
    unsafe();
  if (!pending.some(({ path }) => path === "SKILL.md")) unsafe("SKILL.md");
  if (expected !== undefined && pending.length !== expected.length) unsafe();
  return { files: pending, contents };
}

export async function extractTarGzip(
  source: Uint8Array,
  limits: NormalizedActivationLimits,
): Promise<ReadonlyMap<string, Uint8Array>> {
  const compressed = new Uint8Array(source);
  const metadata = await tarPass(compressed, limits);
  return (await tarPass(compressed, limits, metadata.files)).contents;
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

function crc32(bytes: Uint8Array): number {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) checksum = (checksum >>> 8) ^ (crcTable[(checksum ^ byte) & 0xff] ?? 0);
  return (checksum ^ 0xffff_ffff) >>> 0;
}

function findEndRecord(bytes: Buffer): number {
  const earliest = Math.max(0, bytes.length - 65_557);
  for (let offset = bytes.length - 22; offset >= earliest; offset -= 1) {
    if (
      bytes.readUInt32LE(offset) === 0x0605_4b50 &&
      offset + 22 + bytes.readUInt16LE(offset + 20) === bytes.length
    )
      return offset;
  }
  unsafe();
}

interface ZipEntry {
  readonly path: string;
  readonly rawPath: string;
  readonly method: number;
  readonly flags: number;
  readonly checksum: number;
  readonly compressedSize: number;
  readonly size: number;
  readonly localOffset: number;
  readonly centralName: Uint8Array;
}

export function extractZip(
  source: Uint8Array,
  limits: NormalizedActivationLimits,
): ReadonlyMap<string, Uint8Array> {
  const bytes = Buffer.from(source.buffer, source.byteOffset, source.byteLength);
  if (bytes.length < 22) unsafe();
  const end = findEndRecord(bytes);
  if (
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0 ||
    bytes.readUInt16LE(end + 8) !== bytes.readUInt16LE(end + 10)
  )
    unsafe();
  const count = bytes.readUInt16LE(end + 10);
  const centralSize = bytes.readUInt32LE(end + 12);
  const centralStart = bytes.readUInt32LE(end + 16);
  if (centralStart + centralSize !== end) unsafe();
  // Bound all records by their minimum encoded size, independently of regular-file limits.
  if (count > Math.floor(centralSize / 46)) unsafe();
  const entries: ZipEntry[] = [];
  const collisionKeys = new Set<string>();
  const normalizedPaths = new Set<string>();
  let cursor = centralStart;
  let total = 0;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x0201_4b50) unsafe();
    const flags = bytes.readUInt16LE(cursor + 8);
    const method = bytes.readUInt16LE(cursor + 10);
    const checksum = bytes.readUInt32LE(cursor + 16);
    const compressedSize = bytes.readUInt32LE(cursor + 20);
    const size = bytes.readUInt32LE(cursor + 24);
    const nameLength = bytes.readUInt16LE(cursor + 28);
    const extraLength = bytes.readUInt16LE(cursor + 30);
    const commentLength = bytes.readUInt16LE(cursor + 32);
    const external = bytes.readUInt32LE(cursor + 38);
    const localOffset = bytes.readUInt32LE(cursor + 42);
    const next = cursor + 46 + nameLength + extraLength + commentLength;
    if (next > end || (flags & ~0x0808) !== 0 || (method !== 0 && method !== 8)) unsafe();
    const nameBytes = bytes.subarray(cursor + 46, cursor + 46 + nameLength);
    let rawPath: string;
    try {
      rawPath = utf8.decode(nameBytes);
    } catch {
      unsafe();
    }
    if (rawPath.includes("\0")) unsafe();
    const madeBy = bytes.readUInt16LE(cursor + 4) >>> 8;
    const unixType = madeBy === 3 ? (external >>> 16) & 0xf000 : 0;
    const kind = classifyZipEntryKind(unixType, rawPath.endsWith("/"));
    if (kind === undefined) unsafe(rawPath);
    const directory = kind === "directory";
    const pathCandidate = directory && rawPath.endsWith("/") ? rawPath.slice(0, -1) : rawPath;
    const path = registerPath(pathCandidate, collisionKeys, normalizedPaths);
    if (directory && path === "SKILL.md") unsafe("SKILL.md");
    if (!directory) {
      if (entries.length >= limits.files) exceeded("files");
      if (size > limits.fileBytes) exceeded("file_bytes");
      total += size;
      if (!Number.isSafeInteger(total) || total > limits.extractedBytes)
        exceeded("extracted_bytes");
      entries.push({
        path,
        rawPath,
        method,
        flags,
        checksum,
        compressedSize,
        size,
        localOffset,
        centralName: nameBytes,
      });
    } else if (size !== 0) unsafe(rawPath);
    cursor = next;
  }
  if (cursor !== end) unsafe();
  if (!entries.some(({ path }) => path === "SKILL.md")) unsafe("SKILL.md");

  const files = new Map<string, Uint8Array>();
  for (const entry of entries) {
    const local = entry.localOffset;
    if (local + 30 > centralStart || bytes.readUInt32LE(local) !== 0x0403_4b50)
      unsafe(entry.rawPath);
    const localFlags = bytes.readUInt16LE(local + 6);
    const localMethod = bytes.readUInt16LE(local + 8);
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + entry.compressedSize;
    if (
      dataEnd > centralStart ||
      localFlags !== entry.flags ||
      localMethod !== entry.method ||
      !bytes.subarray(local + 30, local + 30 + localNameLength).equals(entry.centralName)
    )
      unsafe(entry.rawPath);
    if (
      (entry.flags & 0x08) === 0 &&
      (bytes.readUInt32LE(local + 14) !== entry.checksum ||
        bytes.readUInt32LE(local + 18) !== entry.compressedSize ||
        bytes.readUInt32LE(local + 22) !== entry.size)
    )
      unsafe(entry.rawPath);
    let contents: Buffer;
    try {
      contents =
        entry.method === 0
          ? Buffer.from(bytes.subarray(dataStart, dataEnd))
          : inflateRawSync(bytes.subarray(dataStart, dataEnd), {
              maxOutputLength: Math.min(limits.fileBytes + 1, entry.size + 1),
            });
    } catch {
      unsafe(entry.rawPath);
    }
    if (contents.length !== entry.size || crc32(contents) !== entry.checksum) unsafe(entry.rawPath);
    files.set(entry.path, new Uint8Array(contents));
  }
  return files;
}

export async function verifyCachedExtraction(object: CachedObject): Promise<boolean> {
  if (object.metadata.artifactType !== "archive")
    return object.metadata.artifactType === "skill-md";
  const largest = object.metadata.files.reduce((maximum, file) => Math.max(maximum, file.size), 0);
  const limits: NormalizedActivationLimits = {
    archiveBytes: Math.max(1, object.metadata.artifactBytes),
    extractedBytes: Math.max(1, object.metadata.extractedBytes),
    files: Math.max(1, object.metadata.files.length),
    fileBytes: Math.max(1, largest),
  };
  let extracted: ReadonlyMap<string, Uint8Array>;
  if (object.metadata.archiveFormat === "zip") extracted = extractZip(object.artifact, limits);
  else if (object.metadata.archiveFormat === "tar.gz")
    extracted = await extractTarGzip(object.artifact, limits);
  else return false;
  if (extracted.size !== object.root.size) return false;
  for (const [path, bytes] of extracted) {
    const cached = object.root.get(path);
    if (cached === undefined || !Buffer.from(cached).equals(Buffer.from(bytes))) return false;
  }
  return true;
}
