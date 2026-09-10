// @ts-check

import { constants as bufferConstants } from "node:buffer";

import { buildLimit, invalidBuild } from "./errors.ts";
import pako from "./vendor/pako-deflate.mjs";

const TAR_BLOCK = 512;
const TAR_RECORD = 10_240;
const UINT32_MAX = 0xffff_ffff;
const ZIP_FILE_MODE = 0x81a4;

type StreamingDeflater = {
  err: number;
  onData: (chunk: Uint8Array) => void;
  onEnd: () => void;
  push: (chunk: Uint8Array, final: boolean) => boolean;
};

/** @param {unknown} value @returns {value is StreamingDeflater} */
function isStreamingDeflater(value: unknown): value is StreamingDeflater {
  if (typeof value !== "object" || value === null) return false;
  /** @type {unknown} */
  const err: unknown = Reflect.get(value, "err");
  /** @type {unknown} */
  const onData: unknown = Reflect.get(value, "onData");
  /** @type {unknown} */
  const onEnd: unknown = Reflect.get(value, "onEnd");
  /** @type {unknown} */
  const push: unknown = Reflect.get(value, "push");
  return (
    typeof err === "number" &&
    typeof onData === "function" &&
    typeof onEnd === "function" &&
    typeof push === "function"
  );
}

/** @param {{level: number, raw: boolean, chunkSize: number}} options */
function createStreamingDeflater(options: { level: number; raw: boolean; chunkSize: number }) {
  if (!("Deflate" in pako) || typeof pako.Deflate !== "function") {
    throw invalidBuild("deterministic archive compressor is unavailable");
  }
  /** @type {unknown} */
  const deflater: unknown = Reflect.construct(pako.Deflate, [options]);
  if (!isStreamingDeflater(deflater)) {
    throw invalidBuild("deterministic archive compressor is invalid");
  }
  return deflater;
}

/** @param {Iterable<Uint8Array>} chunks @param {number} maximum */
function deflateChunksDeterministically(chunks: Iterable<Uint8Array>, maximum: number) {
  if (!Number.isSafeInteger(maximum) || maximum < 0 || maximum > bufferConstants.MAX_LENGTH) {
    throw buildLimit("archive exceeds the configured artifact limit", { limit: "archiveBytes" });
  }
  /** @type {Buffer[]} */
  const outputChunks: Buffer[] = [];
  let total = 0;
  const deflater = createStreamingDeflater({
    level: 9,
    raw: true,
    chunkSize: Math.max(1, Math.min(16_384, maximum + 1)),
  });
  deflater.onData = (/** @type {Uint8Array} */ chunk: Uint8Array) => {
    total += chunk.length;
    if (!Number.isSafeInteger(total) || total > maximum) {
      throw buildLimit("archive exceeds the configured artifact limit", {
        limit: "archiveBytes",
      });
    }
    outputChunks.push(Buffer.from(chunk));
  };
  deflater.onEnd = () => {};
  for (const chunk of chunks) {
    // Empty input cannot advance a non-final deflate stream; finalize it below.
    if (chunk.byteLength === 0) continue;
    if (!deflater.push(chunk, false) || deflater.err) {
      throw invalidBuild("deterministic archive compression failed");
    }
  }
  if (!deflater.push(new Uint8Array(0), true) || deflater.err) {
    throw invalidBuild("deterministic archive compression failed");
  }
  return Buffer.concat(outputChunks, total);
}

/** @param {Uint8Array} bytes @param {number} maximum */
function deflateDeterministically(bytes: Uint8Array, maximum: number) {
  return deflateChunksDeterministically([bytes], maximum);
}

const crcTable = new Uint32Array(256);
for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

/** @param {Uint8Array} bytes */
function crc32(bytes: Uint8Array) {
  return (crc32Update(0xffff_ffff, bytes) ^ 0xffff_ffff) >>> 0;
}

/** @param {number} checksum @param {Uint8Array} bytes */
function crc32Update(checksum: number, bytes: Uint8Array) {
  for (const byte of bytes) checksum = (checksum >>> 8) ^ (crcTable[(checksum ^ byte) & 0xff] ?? 0);
  return checksum >>> 0;
}

/** @param {Buffer} output @param {number} offset @param {number} value */
function writeUInt32(output: Buffer, offset: number, value: number) {
  output.writeUInt32LE(value >>> 0, offset);
}

/** @param {Buffer} output @param {number} offset @param {number} value */
function writeUInt16(output: Buffer, offset: number, value: number) {
  output.writeUInt16LE(value, offset);
}

/** @param {number} value @param {number} width */
function octalField(value: number, width: number) {
  const octal = value.toString(8);
  if (octal.length > width - 1) throw invalidBuild("archive metadata exceeds USTAR bounds");
  return Buffer.from(`${octal.padStart(width - 1, "0")}\0`, "ascii");
}

/** @param {string} name */
function splitUstarName(name: string) {
  const encoded = Buffer.from(name, "utf8");
  if (encoded.length <= 100) return { name: encoded, prefix: Buffer.alloc(0) };
  let separator = name.lastIndexOf("/");
  while (separator > 0) {
    const prefix = Buffer.from(name.slice(0, separator), "utf8");
    const suffix = Buffer.from(name.slice(separator + 1), "utf8");
    if (prefix.length <= 155 && suffix.length <= 100) return { name: suffix, prefix };
    separator = name.lastIndexOf("/", separator - 1);
  }
  throw invalidBuild("included path cannot be represented as deterministic USTAR", { path: name });
}

/** @param {string} name @param {number} size */
function tarHeader(name: string, size: number) {
  const pathname = splitUstarName(name);
  const header = Buffer.alloc(TAR_BLOCK);
  pathname.name.copy(header, 0);
  octalField(0o644, 8).copy(header, 100);
  octalField(0, 8).copy(header, 108);
  octalField(0, 8).copy(header, 116);
  octalField(size, 12).copy(header, 124);
  octalField(0, 12).copy(header, 136);
  header.fill(0x20, 148, 156);
  header[156] = 0x30;
  Buffer.from("ustar\0", "ascii").copy(header, 257);
  Buffer.from("00", "ascii").copy(header, 263);
  pathname.prefix.copy(header, 345);
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  Buffer.from(`${checksum.toString(8).padStart(6, "0")}\0 `, "ascii").copy(header, 148);
  return header;
}

/** @param {{path: string, bytes: Uint8Array}[]} files */
function normalizedFiles(files: { path: string; bytes: Uint8Array }[]) {
  return [...files].sort((left, right) =>
    Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
  );
}

/** @param {{path: string, bytes: Uint8Array}[]} files */
function tarChunks(files: { path: string; bytes: Uint8Array }[]) {
  const ordered = normalizedFiles(files);
  let rawBytes = 1_024;
  for (const file of ordered) {
    const padded = Math.ceil(file.bytes.byteLength / TAR_BLOCK) * TAR_BLOCK;
    rawBytes += TAR_BLOCK + padded;
    if (!Number.isSafeInteger(rawBytes))
      throw buildLimit("archive size exceeds safe bounds", { limit: "archiveBytes" });
  }
  rawBytes = Math.ceil(rawBytes / TAR_RECORD) * TAR_RECORD;
  if (!Number.isSafeInteger(rawBytes) || rawBytes > bufferConstants.MAX_LENGTH) {
    throw buildLimit("archive size exceeds safe bounds", { limit: "archiveBytes" });
  }
  /** @type {Uint8Array[]} */
  const chunks: Uint8Array[] = [];
  let offset = 0;
  let checksum = 0xffff_ffff;
  /** @param {Uint8Array} chunk */
  const append = (chunk: Uint8Array) => {
    chunks.push(chunk);
    checksum = crc32Update(checksum, chunk);
    offset += chunk.byteLength;
  };
  for (const file of ordered) {
    append(tarHeader(file.path, file.bytes.byteLength));
    append(Buffer.from(file.bytes.buffer, file.bytes.byteOffset, file.bytes.byteLength));
    const padding =
      Math.ceil(file.bytes.byteLength / TAR_BLOCK) * TAR_BLOCK - file.bytes.byteLength;
    if (padding > 0) append(Buffer.alloc(padding));
  }
  append(Buffer.alloc(rawBytes - offset));
  return { chunks, rawBytes, checksum: (checksum ^ 0xffff_ffff) >>> 0 };
}

/** @param {{path: string, bytes: Uint8Array}[]} files */
export function encodeTarGzip(
  files: { path: string; bytes: Uint8Array }[],
  maximum = bufferConstants.MAX_LENGTH,
) {
  if (!Number.isSafeInteger(maximum) || maximum < 18 || maximum > bufferConstants.MAX_LENGTH) {
    throw buildLimit("archive exceeds the configured artifact limit", { limit: "archiveBytes" });
  }
  const tar = tarChunks(files);
  const compressed = deflateChunksDeterministically(tar.chunks, maximum - 18);
  const output = Buffer.alloc(10 + compressed.length + 8);
  output.set([0x1f, 0x8b, 0x08, 0x00], 0);
  writeUInt32(output, 4, 0);
  output[8] = 0x02;
  output[9] = 0xff;
  compressed.copy(output, 10);
  writeUInt32(output, 10 + compressed.length, tar.checksum);
  writeUInt32(output, 14 + compressed.length, tar.rawBytes);
  return output;
}

/** @param {{path: string, bytes: Uint8Array}[]} files */
export function encodeZip(
  files: { path: string; bytes: Uint8Array }[],
  maximum = Math.min(UINT32_MAX, bufferConstants.MAX_LENGTH),
) {
  if (!Number.isSafeInteger(maximum) || maximum < 22 || maximum > bufferConstants.MAX_LENGTH) {
    throw buildLimit("archive exceeds the configured artifact limit", { limit: "archiveBytes" });
  }
  const ordered = normalizedFiles(files);
  if (ordered.length > 0xffff)
    throw buildLimit("ZIP entry count exceeds deterministic format bounds", { limit: "files" });
  const records = [];
  let localBytes = 0;
  let centralBytes = 0;
  let fixedBytes = 22;
  const inputs = [];
  for (const file of ordered) {
    const name = Buffer.from(file.path, "utf8");
    if (name.length > 0xffff)
      throw invalidBuild("included path exceeds ZIP bounds", { path: file.path });
    if (file.bytes.byteLength > UINT32_MAX)
      throw buildLimit("file exceeds ZIP32 bounds", { limit: "fileBytes" });
    const flag = Buffer.byteLength(file.path, "utf8") === file.path.length ? 0 : 0x0800;
    fixedBytes += 30 + name.length + 46 + name.length;
    if (!Number.isSafeInteger(fixedBytes) || fixedBytes > maximum || fixedBytes > UINT32_MAX) {
      throw buildLimit("archive exceeds ZIP32 bounds", { limit: "archiveBytes" });
    }
    inputs.push({ file, name, flag });
  }
  let compressedBytes = 0;
  for (const input of inputs) {
    const compressed = deflateDeterministically(
      input.file.bytes,
      maximum - fixedBytes - compressedBytes,
    );
    if (compressed.length > UINT32_MAX)
      throw buildLimit("compressed file exceeds ZIP32 bounds", { limit: "archiveBytes" });
    records.push({
      ...input,
      compressed,
      checksum: crc32(input.file.bytes),
      offset: localBytes,
    });
    compressedBytes += compressed.length;
    localBytes += 30 + input.name.length + compressed.length;
    centralBytes += 46 + input.name.length;
    if (localBytes > UINT32_MAX || centralBytes > UINT32_MAX)
      throw buildLimit("archive exceeds ZIP32 bounds", { limit: "archiveBytes" });
  }
  const total = localBytes + centralBytes + 22;
  if (!Number.isSafeInteger(total) || total > UINT32_MAX || total > bufferConstants.MAX_LENGTH)
    throw buildLimit("archive exceeds ZIP32 bounds", { limit: "archiveBytes" });
  const output = Buffer.alloc(total);
  let localOffset = 0;
  for (const record of records) {
    writeUInt32(output, localOffset, 0x0403_4b50);
    writeUInt16(output, localOffset + 4, 20);
    writeUInt16(output, localOffset + 6, record.flag);
    writeUInt16(output, localOffset + 8, 8);
    writeUInt16(output, localOffset + 10, 0);
    writeUInt16(output, localOffset + 12, 0x21);
    writeUInt32(output, localOffset + 14, record.checksum);
    writeUInt32(output, localOffset + 18, record.compressed.length);
    writeUInt32(output, localOffset + 22, record.file.bytes.byteLength);
    writeUInt16(output, localOffset + 26, record.name.length);
    writeUInt16(output, localOffset + 28, 0);
    record.name.copy(output, localOffset + 30);
    record.compressed.copy(output, localOffset + 30 + record.name.length);
    localOffset += 30 + record.name.length + record.compressed.length;
  }
  let centralOffset = localBytes;
  for (const record of records) {
    writeUInt32(output, centralOffset, 0x0201_4b50);
    writeUInt16(output, centralOffset + 4, 0x0314);
    writeUInt16(output, centralOffset + 6, 20);
    writeUInt16(output, centralOffset + 8, record.flag);
    writeUInt16(output, centralOffset + 10, 8);
    writeUInt16(output, centralOffset + 12, 0);
    writeUInt16(output, centralOffset + 14, 0x21);
    writeUInt32(output, centralOffset + 16, record.checksum);
    writeUInt32(output, centralOffset + 20, record.compressed.length);
    writeUInt32(output, centralOffset + 24, record.file.bytes.byteLength);
    writeUInt16(output, centralOffset + 28, record.name.length);
    writeUInt16(output, centralOffset + 30, 0);
    writeUInt16(output, centralOffset + 32, 0);
    writeUInt16(output, centralOffset + 34, 0);
    writeUInt16(output, centralOffset + 36, 0);
    writeUInt32(output, centralOffset + 38, ZIP_FILE_MODE << 16);
    writeUInt32(output, centralOffset + 42, record.offset);
    record.name.copy(output, centralOffset + 46);
    centralOffset += 46 + record.name.length;
  }
  writeUInt32(output, centralOffset, 0x0605_4b50);
  writeUInt16(output, centralOffset + 4, 0);
  writeUInt16(output, centralOffset + 6, 0);
  writeUInt16(output, centralOffset + 8, records.length);
  writeUInt16(output, centralOffset + 10, records.length);
  writeUInt32(output, centralOffset + 12, centralBytes);
  writeUInt32(output, centralOffset + 16, localBytes);
  writeUInt16(output, centralOffset + 20, 0);
  return output;
}
