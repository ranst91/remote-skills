import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, type TestContext, test } from "node:test";
import {
  preparePythonArtifactCache,
  preparePythonInspector,
} from "../../scripts/release/python-artifacts.ts";

const python =
  process.env.REMOTE_SKILLS_PYTHON ??
  resolve(process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python");
const inspector = resolve("scripts/inspect-python-distributions.py");

const inspectionRoot = mkdtempSync(join(tmpdir(), "release-inspector-tests-"));
let toolingPython: string;
before(() => {
  toolingPython = preparePythonInspector(process.cwd(), inspectionRoot, {
    ...process.env,
    REMOTE_SKILLS_PYTHON: python,
  });
});
after(() => rmSync(inspectionRoot, { recursive: true, force: true }));

const fixtureScript = String.raw`
from io import BytesIO
import json
from pathlib import Path
import stat
import sys
import tarfile
import zipfile
root = Path(sys.argv[1])
options = json.loads(sys.argv[2])
name = options.get("name", "remote-skills-langchain")
module = name.replace("-", "_")
version = "0.0.1a0"
prefix = module + "-" + version
requires_python = ">=3.11,<4.0" if name == "remote-skills-langchain" else ">=3.11"
deps = ["remote-skills==0.0.1a0", "deepagents==0.7.13"] if name == "remote-skills-langchain" else ["uts46==0.2.0"]
manifest = '[project]\nname = ' + json.dumps(name) + '\nversion = "0.0.1a0"\nlicense = "Apache-2.0"\nrequires-python = ' + json.dumps(requires_python) + '\nreadme = "README.md"\ndependencies = ' + json.dumps(deps) + '\n'
(root / "pyproject.toml").write_text(manifest)
descriptor = {"name": name, "version": version, "importName": module, "manifestPath": str(root / "pyproject.toml")}
(root / "descriptor.json").write_text(json.dumps(descriptor))
fields = {"Metadata-Version": "2.4", "Name": name, "Version": version, "License-Expression": "Apache-2.0", "Requires-Python": requires_python, "Requires-Dist": deps}
def metadata(overrides):
    values = dict(fields, **overrides)
    return ''.join(key + ': ' + value + '\n' for key, values in values.items() for value in (values if isinstance(values, list) else [values])).encode() + b'\n'
with zipfile.ZipFile(root / "package.whl", "w") as archive:
    archive.writestr(prefix + ".dist-info/METADATA", metadata(options.get("wheelMetadata", {})))
    archive.writestr(prefix + ".dist-info/licenses/LICENSE", "Apache-2.0")
    if not options.get("missingModule"):
        archive.writestr(module + "/__init__.py", "# no imports during inspection\n")
    if options.get("extraPath"):
        info = zipfile.ZipInfo(options["extraPath"])
        if options.get("symlink"):
            info.create_system = 3
            info.external_attr = (stat.S_IFLNK | 0o777) << 16
        archive.writestr(info, "untrusted-content")
with tarfile.open(root / "package.tar.gz", "w:gz") as archive:
    files = {"PKG-INFO": metadata(options.get("sourceMetadata", {})), "pyproject.toml": manifest.encode(), "LICENSE": b"Apache-2.0", "README.md": b"Fixture", "src/" + module + "/__init__.py": b"# fixture\n"}
    for name, body in files.items():
        info = tarfile.TarInfo(prefix + "/" + name)
        info.size = len(body)
        archive.addfile(info, BytesIO(body))
`;

function directory(t: TestContext): string {
  const result = mkdtempSync(join(tmpdir(), "remote-skills-python-artifact-test-"));
  t.after(() => rmSync(result, { recursive: true, force: true }));
  return result;
}
function fixture(t: TestContext, options: object = {}) {
  const result = directory(t);
  const generated = spawnSync(
    python,
    ["-I", "-c", fixtureScript, result, JSON.stringify(options)],
    { encoding: "utf8", shell: false },
  );
  assert.equal(generated.status, 0, generated.stderr);
  return result;
}
function inspect(path: string) {
  return spawnSync(
    toolingPython,
    [
      "-I",
      inspector,
      "--descriptor",
      join(path, "descriptor.json"),
      join(path, "package.whl"),
      join(path, "package.tar.gz"),
    ],
    { encoding: "utf8", shell: false },
  );
}

for (const name of ["remote-skills", "remote-skills-langchain"]) {
  test(`descriptor inspection checks both ${name} archive formats`, (t) => {
    const result = inspect(fixture(t, { name }));
    assert.equal(result.status, 0, result.stderr);
    const value: unknown = JSON.parse(result.stdout);
    assert.ok(Array.isArray(value));
    assert.deepEqual(
      value.map((entry: unknown) => {
        assert.ok(entry && typeof entry === "object");
        return Reflect.get(entry, "archive");
      }),
      ["wheel", "sdist"],
    );
  });
}
for (const { name, options, message } of [
  {
    name: "wheel version drift",
    options: { wheelMetadata: { Version: "0.0.1a1" } },
    message: /unexpected distribution Version/u,
  },
  {
    name: "wheel Python constraint drift",
    options: { wheelMetadata: { "Requires-Python": ">=3.12" } },
    message: /unexpected distribution Requires-Python/u,
  },
  {
    name: "omitted wheel SDK dependency",
    options: { wheelMetadata: { "Requires-Dist": ["deepagents==0.7.13"] } },
    message: /unexpected distribution Requires-Dist/u,
  },
  {
    name: "source metadata dependency drift",
    options: { sourceMetadata: { "Requires-Dist": [] } },
    message: /unexpected distribution Requires-Dist/u,
  },
  {
    name: "local dependency URL",
    options: { wheelMetadata: { "Requires-Dist": ["remote-skills @ file:///workspace/sdk"] } },
    message: /must not contain direct URLs/u,
  },
  {
    name: "missing installed module",
    options: { missingModule: true },
    message: /missing required files/u,
  },
  {
    name: "workspace files",
    options: { extraPath: "remote_skills_langchain/tests/private.py" },
    message: /workspace-only content/u,
  },
  {
    name: "traversal paths",
    options: { extraPath: "../outside.py" },
    message: /unsafe or duplicate/u,
  },
  {
    name: "symbolic links",
    options: { extraPath: "remote_skills_langchain/alias.py", symlink: true },
    message: /symbolic links/u,
  },
  {
    name: "SDK fixture adapters",
    options: { name: "remote-skills", extraPath: "remote_skills/protocol_adapter.py" },
    message: /workspace-only protocol adapters/u,
  },
]) {
  test(`Python distribution inspection rejects ${name}`, (t) => {
    const result = inspect(fixture(t, options));
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, message);
  });
}

test("Python dependency preparation rejects an incompatible candidate SDK before cache setup", (t) => {
  const root = directory(t);
  for (const project of ["sdk", "integration"]) mkdirSync(join(root, project));
  writeFileSync(
    join(root, "sdk/pyproject.toml"),
    readFileSync("packages/sdk-python/pyproject.toml"),
  );
  writeFileSync(
    join(root, "integration/pyproject.toml"),
    readFileSync("integrations/langchain-python/pyproject.toml", "utf8").replace(
      /remote-skills==[^"]+/u,
      "remote-skills==9.0.0",
    ),
  );
  const base = spawnSync(python, ["-I", "-c", "import sys; print(sys._base_executable)"], {
    encoding: "utf8",
  });
  assert.equal(base.status, 0);
  assert.throws(
    () =>
      preparePythonArtifactCache(
        root,
        root,
        { ...process.env, UV_OFFLINE: "true", REMOTE_SKILLS_PYTHON: base.stdout.trim() },
        [
          { name: "remote-skills", manifest: "sdk/pyproject.toml" },
          { name: "remote-skills-langchain", manifest: "integration/pyproject.toml" },
        ],
      ),
    /incompatible with candidate remote-skills/u,
  );
  assert.equal(existsSync(join(root, "locked-runtime.txt")), false);
  assert.equal(existsSync(join(root, "prepare-python")), false);
});
