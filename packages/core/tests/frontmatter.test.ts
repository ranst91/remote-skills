import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { validateSkillMarkdown } from "../src/authoring/frontmatter.ts";

const validFixture = readFileSync(
  new URL("../../../tests/protocol/fixtures/archive/skill-md/valid.md", import.meta.url),
  "utf8",
);

function readProtocolFixture(name: string) {
  return readFileSync(
    new URL(`../../../tests/protocol/fixtures/archive/skill-md/${name}`, import.meta.url),
    "utf8",
  );
}

function assertDiagnosticRedacted(value: unknown, canaries: string[]) {
  if (typeof value === "string") {
    for (const canary of canaries) assert.equal(value.includes(canary), false);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) assertDiagnosticRedacted(item, canaries);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, item] of Object.entries(value)) {
      assertDiagnosticRedacted(key, canaries);
      assertDiagnosticRedacted(item, canaries);
    }
  }
}

function captureProcessDiagnostics(operation: () => void) {
  const originalEmitWarning = process.emitWarning;
  const originalStderrWrite = process.stderr.write;
  const warnings: string[] = [];
  const stderr: string[] = [];
  process.emitWarning = (warning) => {
    warnings.push(String(warning));
  };
  process.stderr.write = (...args) => {
    stderr.push(args.map(String).join(""));
    return true;
  };
  try {
    operation();
  } finally {
    process.emitWarning = originalEmitWarning;
    process.stderr.write = originalStderrWrite;
  }
  return { stderr, warnings };
}

test("validates the checked-in canonical skill-md fixture", () => {
  const result = validateSkillMarkdown(validFixture, {
    directoryName: "fixture-skill",
    sourcePath: "skills/fixture-skill/SKILL.md",
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skill, {
    name: "fixture-skill",
    description: "Exercise archive safety.",
    frontmatter: {
      name: "fixture-skill",
      description: "Exercise archive safety.",
    },
    body: "\n# Fixture skill\n",
    sourcePath: "skills/fixture-skill/SKILL.md",
  });
});

for (const [fixture, field] of [
  ["missing-frontmatter.md", "SKILL.md.frontmatter"],
  ["malformed-yaml.md", "SKILL.md.frontmatter"],
  ["missing-name.md", "name"],
  ["missing-description.md", "description"],
  ["invalid-name.md", "name"],
  ["invalid-metadata.md", "metadata"],
]) {
  test(`rejects the checked-in ${fixture} protocol fixture`, () => {
    assert.ok(fixture);
    assert.ok(field);
    const result = validateSkillMarkdown(readProtocolFixture(fixture), {
      directoryName: "fixture-skill",
      sourcePath: `skills/fixture-skill/${fixture}`,
    });

    assert.equal(result.skill, null);
    assert.deepEqual(
      result.diagnostics.map(({ severity, code, context }) => ({
        severity,
        code,
        field: context.field,
      })),
      [{ severity: "error", code: "catalog_invalid", field }],
    );
  });
}

test("preserves canonical optional metadata without interpreting allowed-tools", () => {
  const source = `---
name: release-notes
description: >-
  Draft release notes from verified project inputs.
license: Apache-2.0
compatibility: Requires a Git history supplied by the host.
metadata:
  author: example-org
  version: "1.0"
allowed-tools: Bash(git:*) Read
---
# Release notes
`;

  const result = validateSkillMarkdown(source, {
    directoryName: "release-notes",
    sourcePath: "skills/release-notes/SKILL.md",
  });

  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(result.skill?.frontmatter, {
    name: "release-notes",
    description: "Draft release notes from verified project inputs.",
    license: "Apache-2.0",
    compatibility: "Requires a Git history supplied by the host.",
    metadata: { author: "example-org", version: "1.0" },
    "allowed-tools": "Bash(git:*) Read",
  });
});

test("rejects unresolved YAML tags without exposing parser warning content", () => {
  const canary = "CUSTOM_TAG_SECRET_CANARY";
  const captured = captureProcessDiagnostics(() => {
    for (const taggedDescription of [
      `!${canary} value`,
      `!<tag:example.test,2026:${canary}> value`,
    ]) {
      const result = validateSkillMarkdown(
        `---\nname: tagged-skill\ndescription: ${taggedDescription}\n---\n# Body\n`,
        { directoryName: "tagged-skill", sourcePath: "skills/tagged-skill/SKILL.md" },
      );

      assert.equal(result.skill, null);
      assert.deepEqual(
        result.diagnostics.map(({ severity, code, message, context }) => ({
          severity,
          code,
          message,
          field: context.field,
        })),
        [
          {
            severity: "error",
            code: "catalog_invalid",
            message: "SKILL.md frontmatter must be valid YAML",
            field: "SKILL.md.frontmatter",
          },
        ],
      );
      assertDiagnosticRedacted(result.diagnostics, [canary]);
    }
  });

  assertDiagnosticRedacted(captured, [canary]);
  assert.deepEqual(captured, { stderr: [], warnings: [] });
});

test("preserves supported core YAML tags", () => {
  const result = validateSkillMarkdown(
    `---
name: tagged-skill
description: !!str Supported core tags remain declarative.
license: !!str Apache-2.0
---
# Body
`,
    { directoryName: "tagged-skill", sourcePath: "skills/tagged-skill/SKILL.md" },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skill?.description, "Supported core tags remain declarative.");
  assert.equal(result.skill?.frontmatter.license, "Apache-2.0");
});

test("requires the canonical name to match its directory", () => {
  const result = validateSkillMarkdown(validFixture, {
    directoryName: "different-directory",
    sourcePath: "skills/different-directory/SKILL.md",
  });

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ severity, code, context }) => ({
      severity,
      code,
      field: context.field,
    })),
    [{ severity: "error", code: "catalog_invalid", field: "name" }],
  );
});

test("enforces every canonical name and description boundary", () => {
  const invalidNames = [
    "-leading",
    "trailing-",
    "double--hyphen",
    "Uppercase",
    "café",
    "技能",
    "a".repeat(65),
  ];
  for (const name of invalidNames) {
    const result = validateSkillMarkdown(
      `---\nname: ${name}\ndescription: A valid description.\n---\n# Body\n`,
      { directoryName: name, sourcePath: `skills/${name}/SKILL.md` },
    );
    assert.equal(result.skill, null);
    assert.ok(result.diagnostics.some(({ context }) => context.field === "name"));
  }

  for (const description of ["   ", "x".repeat(1_025)]) {
    const result = validateSkillMarkdown(
      `---\nname: bounded-skill\ndescription: ${JSON.stringify(description)}\n---\n# Body\n`,
      { directoryName: "bounded-skill", sourcePath: "skills/bounded-skill/SKILL.md" },
    );
    assert.equal(result.skill, null);
    assert.ok(result.diagnostics.some(({ context }) => context.field === "description"));
  }
});

test("rejects escaped lone surrogates in every frontmatter string position", () => {
  const invalidValues = ["\\uD800", "\\uDC00"];
  const fieldCases: ReadonlyArray<readonly [string, (value: string) => string]> = [
    ["name", (value: string) => `name: "${value}"\ndescription: Valid description.`],
    ["description", (value: string) => `name: scalar-skill\ndescription: "${value}"`],
    [
      "license",
      (value: string) => `name: scalar-skill\ndescription: Valid description.\nlicense: "${value}"`,
    ],
    [
      "compatibility",
      (value: string) =>
        `name: scalar-skill\ndescription: Valid description.\ncompatibility: "${value}"`,
    ],
    [
      "allowed-tools",
      (value: string) =>
        `name: scalar-skill\ndescription: Valid description.\nallowed-tools: "${value}"`,
    ],
    [
      "metadata",
      (value: string) =>
        `name: scalar-skill\ndescription: Valid description.\nmetadata:\n  key: "${value}"`,
    ],
    [
      "metadata",
      (value: string) =>
        `name: scalar-skill\ndescription: Valid description.\nmetadata:\n  "${value}": value`,
    ],
    [
      "metadata",
      (value: string) =>
        `name: scalar-skill\ndescription: Valid description.\nmetadata:\n  nested:\n    value: "${value}"`,
    ],
  ];

  for (const value of invalidValues) {
    for (const [expectedField, frontmatter] of fieldCases) {
      const result = validateSkillMarkdown(`---\n${frontmatter(value)}\n---\n# Body\n`, {
        directoryName: "scalar-skill",
        sourcePath: "skills/scalar-skill/SKILL.md",
      });

      assert.equal(result.skill, null);
      assert.ok(result.diagnostics.some(({ context }) => context.field === expectedField));
    }
  }
});

test("accepts well-formed non-BMP frontmatter strings and metadata", () => {
  const result = validateSkillMarkdown(
    `---
name: scalar-skill
description: "Describe 😀"
license: "License 😀"
compatibility: "Works with 😀"
metadata:
  "key😀": "value😀"
allowed-tools: "Read😀"
---
# Body
`,
    { directoryName: "scalar-skill", sourcePath: "skills/scalar-skill/SKILL.md" },
  );

  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.skill?.name, "scalar-skill");
});

test("bounds wide frontmatter traversal without recursive argument expansion", () => {
  const sequence = Array.from({ length: 150_000 }, () => "  - value").join("\n");
  const source = `---
name: bounded-frontmatter
description: Validate bounded frontmatter traversal.
allowed-tools:
${sequence}
---
# Body
`;

  const result = validateSkillMarkdown(source, {
    directoryName: "bounded-frontmatter",
    sourcePath: "skills/bounded-frontmatter/SKILL.md",
  });

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ severity, code, context }) => ({
      severity,
      code,
      limit: context.limit,
    })),
    [{ severity: "error", code: "limit_exceeded", limit: "frontmatterNodes" }],
  );
});

test("rejects invalid UTF-8 directly from the checked-in protocol fixture", () => {
  const bytes = readFileSync(
    new URL("../../../tests/protocol/fixtures/archive/skill-md/invalid-utf8.md", import.meta.url),
  );

  const result = validateSkillMarkdown(bytes, {
    directoryName: "fixture-skill",
    sourcePath: "skills/fixture-skill/SKILL.md",
  });

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ code, context }) => ({ code, field: context.field })),
    [{ code: "catalog_invalid", field: "SKILL.md" }],
  );
});

test("rejects non-string metadata keys without exposing their source text", () => {
  const canary = "METADATA_KEY_SECRET_CANARY";
  const invalidEntries = ["  1: value", "  true: value", `  ? [${canary}]\n  : value`];
  const captured = captureProcessDiagnostics(() => {
    for (const entry of invalidEntries) {
      const source = `---
name: typed-skill
description: Validate metadata key types.
metadata:
${entry}
---
# Body
`;
      const result = validateSkillMarkdown(source, {
        directoryName: "typed-skill",
        sourcePath: "skills/typed-skill/SKILL.md",
      });

      assert.equal(result.skill, null);
      assert.deepEqual(
        result.diagnostics.map(({ code, context }) => ({ code, field: context.field })),
        [{ code: "catalog_invalid", field: "metadata" }],
      );
      assertDiagnosticRedacted(result.diagnostics, [canary]);
    }
  });
  assert.deepEqual(captured, { stderr: [], warnings: [] });
});

test("rejects invalid optional field types", () => {
  const result = validateSkillMarkdown(
    `---
name: typed-skill
description: Validate optional fields.
compatibility: ${"x".repeat(501)}
allowed-tools:
  - Read
---
# Body
`,
    { directoryName: "typed-skill", sourcePath: "skills/typed-skill/SKILL.md" },
  );

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ context }) => context.field),
    ["compatibility", "allowed-tools"],
  );
});

test("redacts unknown frontmatter keys from diagnostics", () => {
  const unknownFieldCanary = "UNKNOWN_FIELD_SECRET_CANARY";
  const result = validateSkillMarkdown(
    `---
name: trusted-directory
description: Validate frontmatter diagnostic redaction.
${unknownFieldCanary}: value
---
# Body
`,
    { directoryName: "trusted-directory", sourcePath: "skills/trusted-directory/SKILL.md" },
  );

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ context }) => ({
      field: context.field,
      skillName: context.skill_name,
    })),
    [{ field: "[unknown-field]", skillName: "trusted-directory" }],
  );
  assertDiagnosticRedacted(result.diagnostics, [unknownFieldCanary]);
});

test("redacts invalid frontmatter names from diagnostics", () => {
  const invalidNameCanary = "INVALID_NAME_SECRET_CANARY";
  const result = validateSkillMarkdown(
    `---
name: ${invalidNameCanary}
description: Validate frontmatter diagnostic redaction.
---
# Body
`,
    { directoryName: "trusted-directory", sourcePath: "skills/trusted-directory/SKILL.md" },
  );

  assert.equal(result.skill, null);
  assert.deepEqual(
    result.diagnostics.map(({ context }) => ({
      field: context.field,
      skillName: context.skill_name,
    })),
    [{ field: "name", skillName: "trusted-directory" }],
  );
  assertDiagnosticRedacted(result.diagnostics, [invalidNameCanary]);
});

test("rejects non-string top-level keys before YAML conversion without emitting canaries", () => {
  const canary = "TOP_LEVEL_KEY_SECRET_CANARY";
  const captured = captureProcessDiagnostics(() => {
    for (const entry of ["1: value", "true: value", `? [${canary}]\n: value`]) {
      const result = validateSkillMarkdown(
        `---
name: trusted-directory
description: Validate top-level key handling.
${entry}
---
# Body
`,
        { directoryName: "trusted-directory", sourcePath: "skills/trusted-directory/SKILL.md" },
      );

      assert.equal(result.skill, null);
      assert.deepEqual(
        result.diagnostics.map(({ context }) => ({
          field: context.field,
          skillName: context.skill_name,
        })),
        [{ field: "[unknown-field]", skillName: "trusted-directory" }],
      );
      assertDiagnosticRedacted(result.diagnostics, [canary]);
    }
  });
  assertDiagnosticRedacted(captured, [canary]);
  assert.deepEqual(captured, { stderr: [], warnings: [] });
});

test("counts description and compatibility limits in Unicode code points", () => {
  const withinLimits = validateSkillMarkdown(
    `---
name: unicode-skill
description: ${JSON.stringify("😀".repeat(1_024))}
compatibility: ${JSON.stringify("🚀".repeat(500))}
---
# Body
`,
    { directoryName: "unicode-skill", sourcePath: "skills/unicode-skill/SKILL.md" },
  );
  const overLimits = validateSkillMarkdown(
    `---
name: unicode-skill
description: ${JSON.stringify("😀".repeat(1_025))}
compatibility: ${JSON.stringify("🚀".repeat(501))}
---
# Body
`,
    { directoryName: "unicode-skill", sourcePath: "skills/unicode-skill/SKILL.md" },
  );

  assert.deepEqual(withinLimits.diagnostics, []);
  assert.deepEqual(
    overLimits.diagnostics.map(({ context }) => context.field),
    ["description", "compatibility"],
  );
});

test("uses the shared stable error core for frontmatter diagnostics", () => {
  const result = validateSkillMarkdown("not frontmatter\n", {
    directoryName: "invalid-skill",
    sourcePath: "skills/invalid-skill/SKILL.md",
  });
  const diagnostic = result.diagnostics[0];
  assert.ok(diagnostic);

  assert.equal(diagnostic.code, "catalog_invalid");
  assert.equal(diagnostic.retryable, false);
  assert.deepEqual(diagnostic.context, {
    field: "SKILL.md.frontmatter",
    path: "skills/invalid-skill/SKILL.md",
    skill_name: "invalid-skill",
  });
  assert.equal(Object.hasOwn(diagnostic, "field"), false);
  assert.equal(Object.hasOwn(diagnostic, "path"), false);
  assert.equal(Object.hasOwn(diagnostic, "skillName"), false);
});
