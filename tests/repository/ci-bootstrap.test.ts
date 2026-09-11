import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";

function jsonObject(value: unknown, label: string): object {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object`);
  }
  return value;
}

function parseJsonObject(source: string, label: string): object {
  const value: unknown = JSON.parse(source);
  return jsonObject(value, label);
}

function property(value: object, field: string): unknown {
  return Reflect.get(value, field);
}

function objectProperty(value: object, field: string): object {
  return jsonObject(property(value, field), field);
}

function stringProperty(value: object, field: string): string {
  const member = property(value, field);
  if (typeof member !== "string") throw new TypeError(`${field} must be a string`);
  return member;
}

function rootManifest(): object {
  return parseJsonObject(readFileSync("package.json", "utf8"), "root package manifest");
}

function rootScripts(): object {
  return objectProperty(rootManifest(), "scripts");
}

function turboConfiguration(): object {
  return parseJsonObject(readFileSync("turbo.json", "utf8"), "Turbo configuration");
}

function describeGroupCommands(group: string): unknown {
  const description = spawnSync(
    process.execPath,
    ["scripts/run-ci-test-group.ts", "--describe-commands", group],
    { encoding: "utf8" },
  );
  assert.equal(description.status, 0, description.stderr);
  return JSON.parse(description.stdout);
}

function workflowJob(workflow: string, jobName: string): string {
  const match = workflow.match(new RegExp(`^  ${jobName}:\\n((?:(?:    .*)?\\n)*)`, "mu"));
  assert.ok(match, `missing CI job: ${jobName}`);
  const body = match[1];
  assert.ok(body !== undefined, `missing CI job body: ${jobName}`);
  return body;
}

test("CI exposes independent static, test, package, and Windows contracts", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");
  const check = workflowJob(workflow, "check");
  const testJob = workflowJob(workflow, "test");
  const packageJob = workflowJob(workflow, "package");
  const windows = workflowJob(workflow, "windows");

  assert.ok(check.includes("name: check (repository)"));
  assert.ok(testJob.includes(`name: test (\${{ matrix.label }})`));
  assert.ok(packageJob.includes("name: test (packaging)"));
  assert.ok(windows.includes("name: test (packages windows)"));

  for (const expected of [
    "runs-on: ubuntu-latest",
    "node-version: 24",
    "cache: pnpm",
    "enable-cache: true",
    ".venv/bin/python",
    "run: pnpm ci:check",
  ])
    assert.ok(check.includes(expected), `missing static CI contract: ${expected}`);

  for (const [group, label] of [
    ["core", "cli"],
    ["typescript", "sdk typescript"],
    ["python", "sdk python"],
    ["protocol", "protocol"],
    ["examples", "docs and examples"],
  ])
    assert.ok(
      testJob.includes(`- group: ${group}\n            label: ${label}\n`),
      `missing CI test label: ${group} -> ${label}`,
    );
  for (const expected of [
    "runs-on: ubuntu-latest",
    "fail-fast: false",
    `run: pnpm ci:test:\${{ matrix.group }}`,
  ])
    assert.ok(testJob.includes(expected), `missing test CI contract: ${expected}`);

  for (const expected of [
    "runs-on: ubuntu-latest",
    "pnpm --dir ../release-tooling publication:readiness",
    "actions/upload-artifact@",
  ])
    assert.ok(packageJob.includes(expected), `missing package CI contract: ${expected}`);

  for (const expected of [
    "runs-on: windows-latest",
    "node-version: 24",
    "cache: pnpm",
    "enable-cache: true",
    ".venv/Scripts/python.exe",
    "run: pnpm windows",
  ])
    assert.ok(windows.includes(expected), `missing Windows CI contract: ${expected}`);

  for (const excluded of [
    "run: pnpm check",
    "run: pnpm ci:check:windows-public",
    "run: pnpm ci:check:product",
    "run: pnpm package:check",
    "run: pnpm test:protocol",
    "run: node tests/protocol/tools/run-determinism-gate.ts",
    "run: pnpm ci:verify-projects",
    "run: pnpm publication:readiness",
    "run: node scripts/check-no-publication.ts",
    "@remote-skills/docs",
  ])
    assert.ok(!windows.includes(excluded), `Windows CI must exclude: ${excluded}`);

  assert.doesNotMatch(workflow, /macos-latest/u);
  assert.doesNotMatch(workflow, /^ {4}needs:/mu);
  assert.doesNotMatch(workflow, /name: .*ubuntu|name: .*linux/iu);
  assert.match(workflow, /SOURCE_DATE_EPOCH: 0/u);
  assert.match(workflow, /PYTHONHASHSEED: 0/u);
  assert.equal(
    (workflow.match(/^\s+- run: pnpm windows\s*$/gmu) ?? []).length,
    1,
    "only the Windows job runs the installed-product compatibility command",
  );
});

test("CI groups own every default test family without nested Turbo repetition", () => {
  const scripts = rootScripts();
  assert.equal(
    property(scripts, "ci:check"),
    "pnpm ci:build:repository && pnpm format:check && pnpm lint && pnpm schema:check && tsc -p tsconfig.repository.json && node scripts/check-typescript-policy.ts && pnpm test:repository:prepared && pnpm ci:verify-projects",
  );
  assert.equal(
    property(scripts, "ci:build:repository"),
    "node scripts/run-turbo.ts build --filter=@remote-skills/core --filter=@remote-skills/cli --filter=@remote-skills/client --filter=@remote-skills/ai-sdk",
  );
  for (const group of ["core", "typescript", "python", "protocol", "examples"])
    assert.equal(
      property(scripts, `ci:test:${group}`),
      `node scripts/run-ci-test-group.ts ${group}`,
    );

  const description = spawnSync(process.execPath, ["scripts/run-ci-test-group.ts", "--describe"], {
    encoding: "utf8",
  });
  assert.equal(description.status, 0, description.stderr);
  const groups: unknown = JSON.parse(description.stdout);
  assert.deepEqual(groups, {
    core: ["@remote-skills/core", "@remote-skills/cli"],
    typescript: ["@remote-skills/client", "@remote-skills/ai-sdk"],
    python: ["@remote-skills/python-workspace"],
    protocol: ["test:protocol", "determinism"],
    examples: [
      "@remote-skills/docs",
      "@remote-skills/example-publisher",
      "@remote-skills/example-typescript-consumer",
      "@remote-skills/example-python-consumer",
      "@remote-skills/example-vercel-ai-sdk",
    ],
  });

  const turbo = turboConfiguration();
  const tasks = objectProperty(turbo, "tasks");
  assert.deepEqual(property(tasks, "check"), { dependsOn: ["^check"], cache: false });
  assert.deepEqual(property(tasks, "@remote-skills/docs#check"), {
    dependsOn: ["@remote-skills/cli#check"],
    cache: false,
  });

  for (const manifestPath of [
    "packages/core/package.json",
    "packages/cli/package.json",
    "packages/sdk-typescript/package.json",
    "integrations/ai-sdk/package.json",
    "packages/sdk-python/package.json",
    "apps/docs/package.json",
    "examples/publisher/package.json",
    "examples/consumers/typescript/package.json",
    "examples/consumers/python/package.json",
  ]) {
    const manifest = parseJsonObject(readFileSync(manifestPath, "utf8"), manifestPath);
    const check = stringProperty(objectProperty(manifest, "scripts"), "check");
    assert.match(check, /(?:typecheck.*test|test.*typecheck)/u, manifestPath);
    assert.doesNotMatch(check, /run-package-gate/u, manifestPath);
  }

  for (const manifestPath of ["packages/core/package.json", "packages/cli/package.json"]) {
    const manifest = parseJsonObject(readFileSync(manifestPath, "utf8"), manifestPath);
    const check = stringProperty(objectProperty(manifest, "scripts"), "check");
    assert.doesNotMatch(
      check,
      /(?:^|&&\s*)pnpm build(?:\s*&&|$)/u,
      `${manifestPath} check must not mutate outputs after the root build barrier`,
    );
  }

  assert.deepEqual(describeGroupCommands("core"), [
    "pnpm --filter @remote-skills/core run build",
    "pnpm --filter @remote-skills/core run check",
    "pnpm --filter @remote-skills/cli run build",
    "pnpm --filter @remote-skills/cli run check",
  ]);
});

test("CI groups that consume the public CLI build it first", () => {
  const cliBuild = "node scripts/run-turbo.ts build --filter=@remote-skills/cli";

  for (const group of ["protocol", "examples"] as const) {
    const commands = describeGroupCommands(group);
    assert.ok(Array.isArray(commands), `${group} commands must be an array`);
    assert.equal(commands[0], cliBuild, `${group} must build the CLI before consuming it`);
  }
});

test("direct root consumers own a clean artifact precondition without duplicate composite builds", () => {
  const scripts = rootScripts();
  assert.equal(
    property(scripts, "test:repository"),
    "pnpm ci:build:repository && pnpm test:repository:prepared",
  );
  assert.equal(
    property(scripts, "test:repository:prepared"),
    "node --test tests/repository/*.test.ts",
  );
  assert.equal(
    property(scripts, "typecheck"),
    "pnpm ci:build:repository && pnpm typecheck:prepared",
  );
  assert.equal(
    property(scripts, "typecheck:prepared"),
    "tsc -p tsconfig.repository.json && node scripts/run-turbo.ts typecheck && node scripts/check-typescript-policy.ts",
  );

  for (const composite of ["check", "ci:check"] as const) {
    const command = stringProperty(scripts, composite);
    assert.ok(command.startsWith("pnpm ci:build:repository && "));
    assert.match(command, /pnpm test:repository:prepared/u);
    assert.doesNotMatch(command, /pnpm test:repository(?:\s|&&|$)/u);
    const commands = command.split(" && ");
    for (const required of [
      "pnpm ci:build:repository",
      "tsc -p tsconfig.repository.json",
      "node scripts/check-typescript-policy.ts",
      "pnpm test:repository:prepared",
    ]) {
      assert.equal(
        commands.filter((entry) => entry === required).length,
        1,
        `${composite} must run ${required} exactly once`,
      );
    }
    assert.ok(
      commands.indexOf("tsc -p tsconfig.repository.json") <
        commands.indexOf("node scripts/check-typescript-policy.ts"),
      `${composite} must compile repository tools before checking the full policy`,
    );
    assert.doesNotMatch(command, /(?:pnpm typecheck|run-turbo\.ts typecheck)/u);
    assert.deepEqual(
      commands.filter((entry) => entry.includes("scripts/run-turbo.ts")),
      composite === "check" ? ["node scripts/run-turbo.ts check"] : [],
      `${composite} must preserve the existing workspace check responsibility`,
    );
  }
});

test("the Windows command runs only clean installed CLI and activation smokes", () => {
  const scripts = rootScripts();
  const windowsCommand = stringProperty(scripts, "windows");
  assert.deepEqual(windowsCommand.split(" && "), [
    'pnpm --filter=@remote-skills/cli exec node --test --test-name-pattern="the local tarball installs offline and runs through direct and no-install binaries" tests/package.test.ts',
    'pnpm --filter=@remote-skills/client exec node --test --test-name-pattern="the local tarball installs from an empty offline store and executes a real session" tests/package-gate.test.ts',
    "pnpm --filter=@remote-skills/python-workspace exec node ../../scripts/run-uv.ts run --no-project --python 3.11 --no-python-downloads python -m unittest tests.test_package.PackageMetadataTests.test_distributions_install_offline_and_run_the_async_quickstart",
  ]);
  assert.doesNotMatch(
    windowsCommand,
    /(?:protocol|repository|determinism|docs|example|readiness)/u,
  );
  assert.equal(property(scripts, "ci:check:product"), undefined);
  assert.equal(property(scripts, "ci:check:windows-public"), undefined);
});

test("the CI project-gate verifier names every workspace", () => {
  const verifier = readFileSync("scripts/verify-project-gates.ts", "utf8");

  for (const project of [
    "@remote-skills/docs",
    "@remote-skills/core",
    "@remote-skills/cli",
    "@remote-skills/client",
    "@remote-skills/ai-sdk",
    "@remote-skills/python-workspace",
    "@remote-skills/example-publisher",
    "@remote-skills/example-typescript-consumer",
    "@remote-skills/example-python-consumer",
    "@remote-skills/example-vercel-ai-sdk",
  ])
    assert.ok(verifier.includes(project), `CI verifier does not require ${project}`);
});

test("the examples group checks each Vercel workspace and runs browser acceptance once", () => {
  const commands = describeGroupCommands("examples");
  assert.ok(Array.isArray(commands));
  for (const suffix of [""]) {
    assert.equal(
      commands.filter(
        (command) =>
          command === `pnpm --filter @remote-skills/example-vercel-ai-sdk${suffix} run check`,
      ).length,
      1,
    );
  }
  assert.equal(commands.filter((command) => command === "pnpm run test:vercel-ai-sdk").length, 1);
  const workflow = workflowJob(readFileSync(".github/workflows/ci.yml", "utf8"), "test");
  assert.match(
    workflow,
    /if: matrix.group == 'examples'\n {8}run: pnpm exec playwright install --with-deps chromium/u,
  );
});

test("Turbo receives and hashes deterministic CI environment values", () => {
  const turbo = turboConfiguration();

  assert.deepEqual(property(turbo, "globalEnv"), [
    "CI",
    "FORCE_COLOR",
    "PYTHONHASHSEED",
    "SOURCE_DATE_EPOCH",
    "TZ",
  ]);
});

test("public-package consumers build dependency artifacts before checks", () => {
  const turbo = turboConfiguration();
  const tasks = objectProperty(turbo, "tasks");

  assert.deepEqual(property(tasks, "build"), {
    dependsOn: ["^build"],
    outputs: ["dist/**"],
  });
  for (const taskName of ["typecheck", "test"]) {
    const task = objectProperty(tasks, taskName);
    const dependsOn = property(task, "dependsOn");
    assert.ok(Array.isArray(dependsOn), `${taskName}.dependsOn must be an array`);
    assert.ok(dependsOn.includes("^build"));
  }
});

test("GitHub Actions are commit-pinned and maintained by Dependabot", () => {
  const workflow = readFileSync(".github/workflows/ci.yml", "utf8");

  for (const [action, major] of [
    ["actions/checkout", "v7"],
    ["actions/setup-node", "v7"],
    ["pnpm/action-setup", "v4"],
    ["astral-sh/setup-uv", "v7"],
  ]) {
    assert.match(
      workflow,
      new RegExp(`uses: ${action}@[0-9a-f]{40} # ${major}\\b`, "u"),
      `${action} must be pinned to a full commit with its major-version comment`,
    );
  }

  assert.ok(existsSync(".github/dependabot.yml"));
  const dependabot = readFileSync(".github/dependabot.yml", "utf8");
  assert.match(dependabot, /package-ecosystem: github-actions/u);
  assert.match(dependabot, /interval: weekly/u);
});
