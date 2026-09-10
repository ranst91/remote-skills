import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";

import { encodeTarGzip, encodeZip } from "../../core/src/build/archive.ts";
import { validateVerifiedArtifact } from "../src/verify-artifact.ts";
import { ArchivePathTable } from "../src/verify-artifact-hierarchy.ts";
import { PublisherVerifyError } from "../src/verify-errors.ts";

type FixtureLimits = { files?: number; file_bytes?: number; extracted_bytes?: number };
type ArchiveCase = {
  id: string;
  path: string;
  category: string;
  artifact_type: "skill-md" | "archive";
  limits?: FixtureLimits;
};
type DefaultLimits = { files: number; file_bytes: number; extracted_bytes: number };

test("archive path admission keeps ancestor kind and spelling consistent in either order", () => {
  const pairs: readonly (readonly [readonly [string, boolean], readonly [string, boolean]])[] = [
    [
      ["references", false],
      ["references/note.txt", false],
    ],
    [
      ["references", false],
      ["references/notes", true],
    ],
    [
      ["references/notes", false],
      ["references/notes/first.txt", false],
    ],
    [
      ["references", false],
      ["references", true],
    ],
    [
      ["References", true],
      ["references/note.txt", false],
    ],
    [
      ["References/first.txt", false],
      ["references/second.txt", false],
    ],
    [
      ["references/Notes/first.txt", false],
      ["references/notes/second.txt", false],
    ],
    [
      ["Straße/first.txt", false],
      ["STRASSE/second.txt", false],
    ],
    [
      ["Note.txt", false],
      ["note.txt", false],
    ],
  ];
  for (const pair of pairs) {
    for (const [first, second] of [pair, [pair[1], pair[0]]] as const) {
      const paths = new ArchivePathTable();
      paths.admit(first[0], first[1]);
      assert.throws(
        () => paths.admit(second[0], second[1]),
        (error) => error instanceof PublisherVerifyError && error.code === "archive_unsafe",
        `${first[0]} then ${second[0]}`,
      );
    }
  }
});

test("archive path admission allows matching implicit and explicit parents and nested siblings", () => {
  const entries = [
    ["references", true],
    ["references/notes", true],
    ["references/notes/first.txt", false],
    ["references/notes/second.txt", false],
    ["references/summary.txt", false],
  ] as const;
  for (const order of [entries, entries.toReversed()]) {
    const paths = new ArchivePathTable();
    for (const entry of order) paths.admit(entry[0], entry[1]);
  }
});

test("archive path admission rejects repeated explicit entries and noncanonical spelling", () => {
  for (const directory of [false, true]) {
    const paths = new ArchivePathTable();
    paths.admit("references", directory);
    assert.throws(
      () => paths.admit("references", directory),
      (error) => error instanceof PublisherVerifyError && error.code === "archive_unsafe",
    );
  }
  const paths = new ArchivePathTable();
  paths.admit("café/note.txt", false);
  assert.throws(
    () => paths.admit("cafe\u0301/other.txt", false),
    (error) => error instanceof PublisherVerifyError && error.code === "archive_unsafe",
  );
});

test("archive path admission scopes component identities to their parent", () => {
  const entries = [
    ["references/notes/notes/first.txt", false],
    ["references/notes/notes/second.txt", false],
    ["references/notes/summary.txt", false],
    ["examples/Notes", false],
    ["Notes", false],
  ] as const;
  for (const order of [entries, entries.toReversed()]) {
    const paths = new ArchivePathTable();
    for (const [name, directory] of order) paths.admit(name, directory);
  }
});

test("archive path admission makes an implicit directory explicit only once", () => {
  const paths = new ArchivePathTable();
  paths.admit("references/notes/first.txt", false);
  paths.admit("references/notes", true);
  paths.admit("references/notes/second.txt", false);
  assert.throws(
    () => paths.admit("references/notes", true),
    (error) => error instanceof PublisherVerifyError && error.code === "archive_unsafe",
  );
});

function jsonObject(value: unknown, field: string): { [key: string]: unknown } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return Object.fromEntries(Object.entries(value));
}

function stringField(object: { [key: string]: unknown }, field: string): string {
  const value = object[field];
  if (typeof value !== "string") throw new Error(`${field} must be a string`);
  return value;
}

function numberField(object: { [key: string]: unknown }, field: string): number {
  const value = object[field];
  if (typeof value !== "number") throw new Error(`${field} must be a number`);
  return value;
}

function parseFixtureLimits(value: unknown): FixtureLimits {
  const object = jsonObject(value, "limits");
  return {
    ...(object.files === undefined ? {} : { files: numberField(object, "files") }),
    ...(object.file_bytes === undefined ? {} : { file_bytes: numberField(object, "file_bytes") }),
    ...(object.extracted_bytes === undefined
      ? {}
      : { extracted_bytes: numberField(object, "extracted_bytes") }),
  };
}

function parseDefaultLimits(value: unknown): DefaultLimits {
  const object = jsonObject(value, "default limits");
  return {
    files: numberField(object, "files"),
    file_bytes: numberField(object, "file_bytes"),
    extracted_bytes: numberField(object, "extracted_bytes"),
  };
}

function parseCases(source: string): { cases: ArchiveCase[]; default_limits: DefaultLimits } {
  const root = jsonObject(JSON.parse(source), "archive cases");
  if (!Array.isArray(root.cases)) throw new Error("cases must be an array");
  const cases = root.cases.map((value, index) => {
    const object = jsonObject(value, `cases[${index}]`);
    const rawArtifactType = stringField(object, "artifact_type");
    let artifactType: ArchiveCase["artifact_type"];
    if (rawArtifactType === "skill-md") artifactType = "skill-md";
    else if (rawArtifactType === "archive") artifactType = "archive";
    else {
      throw new Error("artifact_type must be supported");
    }
    return {
      id: stringField(object, "id"),
      path: stringField(object, "path"),
      category: stringField(object, "category"),
      artifact_type: artifactType,
      ...(object.limits === undefined ? {} : { limits: parseFixtureLimits(object.limits) }),
    };
  });
  const limits = parseDefaultLimits(root.default_limits);
  return { cases, default_limits: limits };
}

function parseExpected(source: string): Map<string, { outcome: string; error?: { code: string } }> {
  const root = jsonObject(JSON.parse(source), "archive expectations");
  if (!Array.isArray(root.cases)) throw new Error("expected cases must be an array");
  return new Map(
    root.cases.map((value, index) => {
      const object = jsonObject(value, `expected cases[${index}]`);
      const result = jsonObject(object.result, "result");
      const error = result.error === undefined ? undefined : jsonObject(result.error, "error");
      return [
        stringField(object, "id"),
        {
          outcome: stringField(result, "outcome"),
          ...(error === undefined ? {} : { error: { code: stringField(error, "code") } }),
        },
      ];
    }),
  );
}

const repositoryRoot = path.resolve(import.meta.dirname, "../../..");
const fixtureRoot = path.join(repositoryRoot, "tests/protocol/fixtures/archive");
const cases = parseCases(await readFile(path.join(fixtureRoot, "archive-cases.json"), "utf8"));
const expectedById = parseExpected(
  await readFile(
    path.join(repositoryRoot, "tests/protocol/expected-results/archive-results.json"),
    "utf8",
  ),
);

test("verifier artifact validation consumes every shared archive and skill-md safety fixture", async () => {
  for (const fixture of cases.cases) {
    if (fixture.category === "archive_byte_limit") continue; // enforced while downloading
    const bytes = await readFile(path.join(fixtureRoot, fixture.path));
    const expectation = expectedById.get(fixture.id);
    assert.ok(expectation, `missing expected result for ${fixture.id}`);
    const options = {
      type: fixture.artifact_type,
      url: new URL(`https://skills.example.test/${fixture.path}`),
      skillName: "fixture-skill",
      limits: {
        files: fixture.limits?.files ?? cases.default_limits.files,
        fileBytes: fixture.limits?.file_bytes ?? cases.default_limits.file_bytes,
        extractedBytes: fixture.limits?.extracted_bytes ?? cases.default_limits.extracted_bytes,
      },
    };
    if (expectation.outcome === "activation_success") {
      await assert.doesNotReject(() => validateVerifiedArtifact(bytes, options), fixture.id);
    } else {
      await assert.rejects(
        () => validateVerifiedArtifact(bytes, options),
        (error) => error instanceof PublisherVerifyError && error.code === expectation.error?.code,
        fixture.id,
      );
    }
  }
});

const ordinaryFiles = [
  {
    path: "SKILL.md",
    bytes: Buffer.from("---\nname: fixture-skill\ndescription: Example.\n---\n\nInstructions.\n"),
  },
  { path: "references/note.txt", bytes: Buffer.from("A short reference.\n") },
];
const totalBytes = ordinaryFiles.reduce((total, file) => total + file.bytes.length, 0);

test("direct Markdown enforces the extracted-byte boundary", async () => {
  const bytes = Buffer.from(
    "---\nname: fixture-skill\ndescription: Example.\n---\n\nInstructions.\n",
  );
  for (const extractedBytes of [bytes.byteLength - 1, bytes.byteLength, bytes.byteLength + 1]) {
    const validate = () =>
      validateVerifiedArtifact(bytes, {
        type: "skill-md",
        url: new URL("https://skills.example.test/ordinary.md"),
        skillName: "fixture-skill",
        limits: { files: 1, fileBytes: bytes.byteLength + 10, extractedBytes },
      });
    if (extractedBytes < bytes.byteLength) {
      await assert.rejects(
        validate,
        (error) =>
          error instanceof PublisherVerifyError &&
          error.code === "limit_exceeded" &&
          error.context.limit === "extractedBytes",
      );
    } else {
      await assert.doesNotReject(validate);
    }
  }
});

test("direct Markdown reports the file-byte limit before the extracted-byte limit", async () => {
  const bytes = Buffer.from(
    "---\nname: fixture-skill\ndescription: Example.\n---\n\nInstructions.\n",
  );
  await assert.rejects(
    () =>
      validateVerifiedArtifact(bytes, {
        type: "skill-md",
        url: new URL("https://skills.example.test/ordinary.md"),
        skillName: "fixture-skill",
        limits: { files: 1, fileBytes: bytes.byteLength - 1, extractedBytes: bytes.byteLength - 1 },
      }),
    (error) =>
      error instanceof PublisherVerifyError &&
      error.code === "limit_exceeded" &&
      error.context.limit === "fileBytes",
  );
});

function archiveOptions(format: "zip" | "tar.gz") {
  return {
    type: "archive" as const,
    url: new URL(`https://skills.example.test/ordinary.${format}`),
    skillName: "fixture-skill",
    limits: { files: ordinaryFiles.length, fileBytes: totalBytes, extractedBytes: totalBytes },
  };
}

test("supported archive media types take precedence over filename suffixes", async (t) => {
  for (const [format, suffix, contentType] of [
    ["tar.gz", "zip", "application/gzip"],
    ["tar.gz", "zip", "application/x-gzip"],
    ["tar.gz", "zip", " Application/GZip ; charset=binary"],
    ["zip", "tar.gz", "application/zip"],
    ["zip", "tgz", " Application/ZIP ; charset=binary"],
  ] as const) {
    await t.test(`${contentType} with .${suffix}`, async () => {
      const bytes = format === "zip" ? encodeZip(ordinaryFiles) : encodeTarGzip(ordinaryFiles);
      await validateVerifiedArtifact(bytes, {
        ...archiveOptions(format),
        url: new URL(`https://skills.example.test/ordinary.${suffix}`),
        contentType,
      });
    });
  }
});

test("archive suffix fallback is case insensitive and supports tgz", async (t) => {
  for (const [format, suffix] of [
    ["zip", "zip"],
    ["zip", "ZIP"],
    ["tar.gz", "tar.gz"],
    ["tar.gz", "TAR.GZ"],
    ["tar.gz", "tgz"],
    ["tar.gz", "TGZ"],
  ] as const) {
    for (const contentType of [undefined, "application/octet-stream"]) {
      await t.test(`${suffix} with ${contentType ?? "no media type"}`, async () => {
        const bytes = format === "zip" ? encodeZip(ordinaryFiles) : encodeTarGzip(ordinaryFiles);
        await validateVerifiedArtifact(bytes, {
          ...archiveOptions(format),
          url: new URL(`https://skills.example.test/ordinary.${suffix}?download=1`),
          ...(contentType === undefined ? {} : { contentType }),
        });
      });
    }
  }
});

test("archive selection keeps unsupported media types and suffixes unsupported", async () => {
  for (const contentType of [undefined, "application/octet-stream"]) {
    await assert.rejects(
      () =>
        validateVerifiedArtifact(encodeZip(ordinaryFiles), {
          ...archiveOptions("zip"),
          url: new URL("https://skills.example.test/ordinary.bin"),
          ...(contentType === undefined ? {} : { contentType }),
        }),
      (error) => error instanceof PublisherVerifyError && error.code === "artifact_unsupported",
    );
  }
});

test("ZIP admits all declared budgets before inflating any ordinary file", async (t) => {
  const bytes = encodeZip(ordinaryFiles);
  const inflate = t.mock.method(zlib, "inflateRawSync");
  syncBuiltinESMExports();
  try {
    for (const [limit, value] of [
      ["files", 1],
      ["fileBytes", 1],
      ["extractedBytes", totalBytes - 1],
    ] as const) {
      const options = archiveOptions("zip");
      options.limits[limit] = value;
      await assert.rejects(
        () => validateVerifiedArtifact(bytes, options),
        (error) =>
          error instanceof PublisherVerifyError &&
          error.code === "limit_exceeded" &&
          error.context.limit === limit,
      );
      assert.equal(inflate.mock.callCount(), 0, `${limit} must be admitted before inflation`);
    }
    await validateVerifiedArtifact(bytes, archiveOptions("zip"));
    assert.equal(inflate.mock.callCount(), ordinaryFiles.length);
    assert.deepEqual(
      inflate.mock.calls.map(({ arguments: args }) => args[1]?.maxOutputLength),
      ordinaryFiles.map(({ bytes: contents }) => contents.length),
    );
  } finally {
    inflate.mock.restore();
    syncBuiltinESMExports();
  }
});

test("TAR admits complete metadata before allocating ordinary file contents", async (t) => {
  const bytes = encodeTarGzip(ordinaryFiles);
  const allocate = t.mock.method(Buffer, "alloc");
  for (const [limit, value] of [
    ["files", 1],
    ["fileBytes", 1],
    ["extractedBytes", totalBytes - 1],
  ] as const) {
    const options = archiveOptions("tar.gz");
    options.limits[limit] = value;
    await assert.rejects(
      () => validateVerifiedArtifact(bytes, options),
      (error) =>
        error instanceof PublisherVerifyError &&
        error.code === "limit_exceeded" &&
        error.context.limit === limit,
    );
    assert.equal(
      allocate.mock.calls.filter(({ arguments: args }) =>
        ordinaryFiles.some(({ bytes: contents }) => contents.length === args[0]),
      ).length,
      0,
    );
  }
  await validateVerifiedArtifact(bytes, archiveOptions("tar.gz"));
  assert.deepEqual(
    allocate.mock.calls
      .map(({ arguments: args }) => args[0])
      .filter((size) => ordinaryFiles.some(({ bytes: contents }) => contents.length === size)),
    ordinaryFiles.map(({ bytes: contents }) => contents.length),
  );
});

// The publisher emits regular files only; this benign stored ZIP also includes directory records.
function directoryZip(entries: readonly { path: string; bytes: Uint8Array }[]): Buffer {
  const locals: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path);
    const checksum = zlib.crc32(entry.bytes);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x0403_4b50);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(entry.bytes.length, 18);
    header.writeUInt32LE(entry.bytes.length, 22);
    header.writeUInt16LE(name.length, 26);
    locals.push(header, name, Buffer.from(entry.bytes));
    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x0201_4b50);
    record.writeUInt16LE(0x0314, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(entry.bytes.length, 20);
    record.writeUInt32LE(entry.bytes.length, 24);
    record.writeUInt16LE(name.length, 28);
    const mode = entry.path.endsWith("/") ? 0o40755 : 0o100644;
    record.writeUInt32LE((mode << 16) >>> 0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(record, name);
    offset += header.length + name.length + entry.bytes.length;
  }
  const records = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x0605_4b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(records.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, records, end]);
}

test("ordinary ZIP and TAR directories do not consume regular-file budgets", async () => {
  const zip = directoryZip([...ordinaryFiles, { path: "references/", bytes: Buffer.alloc(0) }]);
  await validateVerifiedArtifact(zip, archiveOptions("zip"));

  const directory = Buffer.alloc(512);
  directory.write("references/");
  directory.write("0000755\0", 100);
  directory.write("0000000\0", 108);
  directory.write("0000000\0", 116);
  directory.write("00000000000\0", 124);
  directory.write("00000000000\0", 136);
  directory.fill(0x20, 148, 156);
  directory[156] = 0x35;
  directory.write("ustar\0", 257);
  directory.write("00", 263);
  const checksum = directory.reduce((total, byte) => total + byte, 0);
  directory.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148);
  const tar = zlib.gzipSync(
    Buffer.concat([directory, zlib.gunzipSync(encodeTarGzip(ordinaryFiles))]),
  );
  await validateVerifiedArtifact(tar, archiveOptions("tar.gz"));
});

test("TAR streams ordinary multi-chunk contents with exactly two terminal blocks", async () => {
  const files = [
    ...ordinaryFiles,
    {
      path: "references/catalog.txt",
      bytes: Buffer.from(
        Array.from(
          { length: 900 },
          (_, index) => `Reference entry ${index}: example notes.\n`,
        ).join(""),
      ),
    },
  ];
  const extractedBytes = files.reduce((total, file) => total + file.bytes.length, 0);
  const archiveLength = files.reduce(
    (total, file) => total + 512 + Math.ceil(file.bytes.length / 512) * 512,
    1024,
  );
  const tar = zlib.gunzipSync(encodeTarGzip(files)).subarray(0, archiveLength);
  const bytes = zlib.gzipSync(tar, { level: 0 });
  const options = archiveOptions("tar.gz");
  options.limits = { files: files.length, fileBytes: extractedBytes, extractedBytes };
  await validateVerifiedArtifact(bytes, options);
});
