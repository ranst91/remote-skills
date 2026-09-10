// @ts-check

import { constants as bufferConstants } from "node:buffer";
import { gunzipSync, inflateRawSync } from "node:zlib";

import { validateSkillMarkdown } from "../authoring/frontmatter.ts";
import { normalizePortableRelativePath } from "../authoring/paths.ts";
import { buildLimit, invalidBuild } from "./errors.ts";

const TAR_BLOCK = 512;
const TAR_RECORD = 10_240;
const decoder = new TextDecoder("utf-8", { fatal: true });

/** @param {Buffer} bytes @param {number} start @param {number} end */
function nulString(bytes: Buffer, start: number, end: number) {
  const field = bytes.subarray(start, end);
  const nul = field.indexOf(0);
  return decoder.decode(nul < 0 ? field : field.subarray(0, nul));
}

/** @param {Buffer} bytes @param {number} start @param {number} end */
function octal(bytes: Buffer, start: number, end: number) {
  const value = bytes
    .subarray(start, end)
    .toString("ascii")
    .replace(/[\0 ]+$/u, "");
  if (!/^[0-7]+$/u.test(value))
    throw invalidBuild("prior tar archive has invalid metadata", { field: "priorOutput" });
  const parsed = Number.parseInt(value, 8);
  if (!Number.isSafeInteger(parsed))
    throw buildLimit("prior archive metadata exceeds safe bounds", { limit: "archiveBytes" });
  return parsed;
}

/** @param {Buffer} bytes @param {number} expected */
function requireChecksum(bytes: Buffer, expected: number) {
  let sum = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    sum += index >= 148 && index < 156 ? 0x20 : (bytes[index] ?? 0);
  }
  if (sum !== expected)
    throw invalidBuild("prior tar archive checksum is invalid", { field: "priorOutput" });
}

/** @param {Map<string, Buffer>} files @param {string} skillName */
function requireRootSkill(files: Map<string, Buffer>, skillName: string) {
  const root = files.get("SKILL.md");
  if (!root) throw invalidBuild("prior archive is missing root SKILL.md", { field: "priorOutput" });
  const parsed = validateSkillMarkdown(root, { sourcePath: "SKILL.md", directoryName: skillName });
  if (!parsed.skill || parsed.diagnostics.some(({ severity }) => severity === "error")) {
    throw invalidBuild("prior archive contains an invalid root SKILL.md", { field: "priorOutput" });
  }
}

/** @param {number} value @param {number} width */
function normalizedOctal(value: number, width: number) {
  return Buffer.from(`${value.toString(8).padStart(width - 1, "0")}\0`, "ascii");
}

/** @param {string} name */
function normalizedUstarName(name: string) {
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length <= 100) return { name: encoded, prefix: Buffer.alloc(0) };
  let separator = name.lastIndexOf("/");
  while (separator > 0) {
    const prefix = Buffer.from(name.slice(0, separator), "utf8");
    const suffix = Buffer.from(name.slice(separator + 1), "utf8");
    if (prefix.length <= 155 && suffix.length <= 100) return { name: suffix, prefix };
    separator = name.lastIndexOf("/", separator - 1);
  }
  throw invalidBuild("prior tar archive path is not normalized USTAR", { field: "priorOutput" });
}

/** @param {string} name @param {number} size */
function normalizedTarHeader(name: string, size: number) {
  const pathname = normalizedUstarName(name);
  const header = Buffer.alloc(TAR_BLOCK);
  pathname.name.copy(header, 0);
  normalizedOctal(0o644, 8).copy(header, 100);
  normalizedOctal(0, 8).copy(header, 108);
  normalizedOctal(0, 8).copy(header, 116);
  normalizedOctal(size, 12).copy(header, 124);
  normalizedOctal(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  pathname.prefix.copy(header, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

/**
 * @param {Uint8Array} source
 * @param {string} skillName
 * @param {{files: number, fileBytes: number, extractedBytes: number}} limits
 */
function validateTarGzip(
  source: Uint8Array,
  skillName: string,
  limits: { files: number; fileBytes: number; extractedBytes: number },
) {
  // Each regular entry consumes one header plus at most one block of data padding. The archive
  // then has two terminator blocks and at most one record minus one byte of record padding.
  const overhead = limits.files * TAR_BLOCK * 2 + TAR_BLOCK * 2 + (TAR_RECORD - 1);
  const maximum = limits.extractedBytes + overhead;
  if (!Number.isSafeInteger(maximum) || maximum > bufferConstants.MAX_LENGTH) {
    throw buildLimit("prior archive expansion bound exceeds safe allocation", {
      limit: "extractedBytes",
    });
  }
  let bytes: NonSharedBuffer;
  try {
    bytes = gunzipSync(source, { maxOutputLength: maximum });
  } catch {
    throw invalidBuild("prior tar-gzip artifact is malformed", { field: "priorOutput" });
  }
  if (bytes.length === 0 || bytes.length % TAR_RECORD !== 0) {
    throw invalidBuild("prior tar archive record length is not normalized", {
      field: "priorOutput",
    });
  }
  const files = new Map();
  const collisions = new Set();
  let extracted = 0;
  let offset = 0;
  let ended = false;
  let previousName: string | undefined;
  while (offset + TAR_BLOCK <= bytes.length) {
    const header = bytes.subarray(offset, offset + TAR_BLOCK);
    if (header.every((byte: number) => byte === 0)) {
      ended = true;
      break;
    }
    if (collisions.size >= limits.files)
      throw buildLimit("prior archive exceeds file-count limit", { limit: "files" });
    const type = header[156];
    if (type !== 0 && type !== 0x30)
      throw invalidBuild("prior tar archive contains a non-regular entry", {
        field: "priorOutput",
      });
    requireChecksum(header, octal(header, 148, 156));
    let name: string;
    try {
      const suffix = nulString(header, 0, 100);
      const prefix = nulString(header, 345, 500);
      name = prefix ? `${prefix}/${suffix}` : suffix;
    } catch {
      throw invalidBuild("prior tar archive path is not valid UTF-8", { field: "priorOutput" });
    }
    const normalized = normalizePortableRelativePath(name);
    if (!normalized || normalized.path !== name || collisions.has(normalized.collisionKey)) {
      throw invalidBuild("prior tar archive contains an unsafe or duplicate path", {
        field: "priorOutput",
      });
    }
    const size = octal(header, 124, 136);
    if (!header.equals(normalizedTarHeader(name, size))) {
      throw invalidBuild("prior tar archive metadata is not normalized", {
        field: "priorOutput",
      });
    }
    if (
      previousName !== undefined &&
      Buffer.compare(Buffer.from(previousName, "utf8"), Buffer.from(name, "utf8")) >= 0
    ) {
      throw invalidBuild("prior tar archive order is not normalized", { field: "priorOutput" });
    }
    previousName = name;
    if (size > limits.fileBytes)
      throw buildLimit("prior archive file exceeds configured limit", { limit: "fileBytes" });
    extracted += size;
    if (!Number.isSafeInteger(extracted) || extracted > limits.extractedBytes) {
      throw buildLimit("prior archive exceeds extracted-size limit", { limit: "extractedBytes" });
    }
    const dataStart = offset + TAR_BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > bytes.length)
      throw invalidBuild("prior tar archive is truncated", { field: "priorOutput" });
    const next = dataStart + Math.ceil(size / TAR_BLOCK) * TAR_BLOCK;
    if (bytes.subarray(dataEnd, next).some((byte: number) => byte !== 0)) {
      throw invalidBuild("prior tar archive padding is not normalized", { field: "priorOutput" });
    }
    collisions.add(normalized.collisionKey);
    files.set(name, Buffer.from(bytes.subarray(dataStart, dataEnd)));
    offset = next;
  }
  if (
    !ended ||
    bytes.length - offset < TAR_BLOCK * 2 ||
    bytes.subarray(offset).some((byte: number) => byte !== 0)
  ) {
    throw invalidBuild("prior tar archive has an invalid terminator", { field: "priorOutput" });
  }
  requireRootSkill(files, skillName);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1)
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  crcTable[index] = value >>> 0;
}

/** @param {Uint8Array} bytes */
function crc32(bytes: Uint8Array) {
  let checksum = 0xffff_ffff;
  for (const byte of bytes) checksum = (checksum >>> 8) ^ (crcTable[(checksum ^ byte) & 0xff] ?? 0);
  return (checksum ^ 0xffff_ffff) >>> 0;
}

/**
 * @param {Buffer} bytes
 * @param {string} skillName
 * @param {{files: number, fileBytes: number, extractedBytes: number}} limits
 */
function validateZip(
  bytes: Buffer,
  skillName: string,
  limits: { files: number; fileBytes: number; extractedBytes: number },
) {
  if (
    bytes.length < 22 ||
    bytes.readUInt32LE(bytes.length - 22) !== 0x0605_4b50 ||
    bytes.readUInt16LE(bytes.length - 2) !== 0
  ) {
    throw invalidBuild("prior ZIP artifact is malformed", { field: "priorOutput" });
  }
  const eocd = bytes.length - 22;
  if (
    bytes.readUInt16LE(eocd + 4) !== 0 ||
    bytes.readUInt16LE(eocd + 6) !== 0 ||
    bytes.readUInt16LE(eocd + 8) !== bytes.readUInt16LE(eocd + 10)
  ) {
    throw invalidBuild("prior ZIP end record is not normalized", { field: "priorOutput" });
  }
  const count = bytes.readUInt16LE(eocd + 10);
  const centralSize = bytes.readUInt32LE(eocd + 12);
  const centralStart = bytes.readUInt32LE(eocd + 16);
  if (count > limits.files)
    throw buildLimit("prior archive exceeds file-count limit", { limit: "files" });
  if (centralStart + centralSize !== eocd)
    throw invalidBuild("prior ZIP central directory is invalid", { field: "priorOutput" });
  const files = new Map();
  const collisions = new Set();
  let extracted = 0;
  let cursor = centralStart;
  let localCursor = 0;
  let previousName: string | undefined;
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > eocd || bytes.readUInt32LE(cursor) !== 0x0201_4b50)
      throw invalidBuild("prior ZIP central directory is malformed", { field: "priorOutput" });
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
    if (
      next > eocd ||
      bytes.readUInt16LE(cursor + 4) !== 0x0314 ||
      bytes.readUInt16LE(cursor + 6) !== 20 ||
      method !== 8 ||
      (flags & ~0x0800) !== 0 ||
      bytes.readUInt16LE(cursor + 12) !== 0 ||
      bytes.readUInt16LE(cursor + 14) !== 0x21 ||
      external >>> 16 !== 0x81a4 ||
      bytes.readUInt16LE(cursor + 34) !== 0 ||
      bytes.readUInt16LE(cursor + 36) !== 0 ||
      external !== 0x81a4_0000 ||
      extraLength !== 0 ||
      commentLength !== 0
    ) {
      throw invalidBuild("prior ZIP entry metadata is unsafe", { field: "priorOutput" });
    }
    let name: string;
    try {
      name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    } catch {
      throw invalidBuild("prior ZIP path is not valid UTF-8", { field: "priorOutput" });
    }
    const normalized = normalizePortableRelativePath(name);
    if (!normalized || normalized.path !== name || collisions.has(normalized.collisionKey))
      throw invalidBuild("prior ZIP contains an unsafe or duplicate path", {
        field: "priorOutput",
      });
    const expectedFlags = Buffer.byteLength(name, "utf8") === name.length ? 0 : 0x0800;
    if (
      flags !== expectedFlags ||
      (previousName !== undefined &&
        Buffer.compare(Buffer.from(previousName, "utf8"), Buffer.from(name, "utf8")) >= 0)
    ) {
      throw invalidBuild("prior ZIP entry order or flags are not normalized", {
        field: "priorOutput",
      });
    }
    previousName = name;
    if (size > limits.fileBytes)
      throw buildLimit("prior archive file exceeds configured limit", { limit: "fileBytes" });
    extracted += size;
    if (!Number.isSafeInteger(extracted) || extracted > limits.extractedBytes)
      throw buildLimit("prior archive exceeds extracted-size limit", { limit: "extractedBytes" });
    if (
      local !== localCursor ||
      local + 30 > centralStart ||
      bytes.readUInt32LE(local) !== 0x0403_4b50
    )
      throw invalidBuild("prior ZIP local header is invalid", { field: "priorOutput" });
    const localNameLength = bytes.readUInt16LE(local + 26);
    const localExtraLength = bytes.readUInt16LE(local + 28);
    const dataStart = local + 30 + localNameLength + localExtraLength;
    const dataEnd = dataStart + compressedSize;
    if (
      dataEnd > centralStart ||
      bytes.readUInt16LE(local + 4) !== bytes.readUInt16LE(cursor + 6) ||
      bytes.readUInt16LE(local + 6) !== flags ||
      bytes.readUInt16LE(local + 8) !== method ||
      bytes.readUInt16LE(local + 10) !== bytes.readUInt16LE(cursor + 12) ||
      bytes.readUInt16LE(local + 12) !== bytes.readUInt16LE(cursor + 14) ||
      bytes.readUInt32LE(local + 14) !== checksum ||
      bytes.readUInt32LE(local + 18) !== compressedSize ||
      bytes.readUInt32LE(local + 22) !== size ||
      localNameLength !== nameLength ||
      localExtraLength !== 0 ||
      !bytes
        .subarray(local + 30, local + 30 + nameLength)
        .equals(bytes.subarray(cursor + 46, cursor + 46 + nameLength))
    )
      throw invalidBuild("prior ZIP local record is inconsistent", { field: "priorOutput" });
    let contents: Buffer;
    try {
      contents = inflateRawSync(bytes.subarray(dataStart, dataEnd), {
        maxOutputLength: limits.fileBytes,
      });
    } catch {
      throw invalidBuild("prior ZIP compressed data is malformed", { field: "priorOutput" });
    }
    if (contents.length !== size || crc32(contents) !== checksum)
      throw invalidBuild("prior ZIP entry checksum is invalid", { field: "priorOutput" });
    collisions.add(normalized.collisionKey);
    files.set(name, contents);
    localCursor = dataEnd;
    cursor = next;
  }
  if (cursor !== eocd || localCursor !== centralStart)
    throw invalidBuild("prior ZIP central directory length is invalid", { field: "priorOutput" });
  requireRootSkill(files, skillName);
}

/**
 * @param {Uint8Array} bytes
 * @param {{type: "skill-md" | "archive", url: string, skillName: string, limits: {files: number, fileBytes: number, extractedBytes: number}}} options
 */
export function validatePublishedArtifact(
  bytes: Uint8Array,
  options: {
    type: "skill-md" | "archive";
    url: string;
    skillName: string;
    limits: { files: number; fileBytes: number; extractedBytes: number };
  },
) {
  if (options.type === "skill-md") {
    if (bytes.byteLength > options.limits.fileBytes) {
      throw buildLimit("prior skill-md exceeds configured file limit", { limit: "fileBytes" });
    }
    if (bytes.byteLength > options.limits.extractedBytes) {
      throw buildLimit("prior skill-md exceeds configured extracted limit", {
        limit: "extractedBytes",
      });
    }
    const parsed = validateSkillMarkdown(bytes, {
      sourcePath: "SKILL.md",
      directoryName: options.skillName,
    });
    if (!parsed.skill || parsed.diagnostics.some(({ severity }) => severity === "error"))
      throw invalidBuild("prior skill-md artifact is invalid", { field: "priorOutput" });
    return;
  }
  if (options.url.endsWith(".tar.gz")) validateTarGzip(bytes, options.skillName, options.limits);
  else if (options.url.endsWith(".zip"))
    validateZip(Buffer.from(bytes), options.skillName, options.limits);
  else throw invalidBuild("prior archive media type is unsupported", { field: "priorOutput" });
}
