import assert from "node:assert/strict";
import { isAbsolute } from "node:path";
import test from "node:test";
import { selectPythonWheel } from "./helpers/python-wheel.ts";

import {
  parseUvCacheDirectory,
  uvCacheDirectoryArguments,
  uvCacheQueryEnvironment,
} from "./helpers/uv-cache.ts";
import { runCommand } from "../helpers/run-command.ts";

const windowsCache = String.raw`C:\Users\runneradmin\AppData\Local\uv\cache`;
const expectedArguments = ["cache", "dir", "--color", "never", "--no-config"];

for (const version of ["0.0.1", "0.0.1a0"]) {
  test(`the Python example selects the single wheel matching project version ${version}`, () => {
    const wheel = `remote_skills-${version}-py3-none-any.whl`;
    assert.equal(selectPythonWheel([wheel], `[project]\nversion = "${version}"\n`), wheel);
  });
}

test("the Python example rejects missing, unexpected, or multiple build artifacts", () => {
  const wheel = "remote_skills-0.0.1a0-py3-none-any.whl";
  for (const built of [
    [],
    ["other-0.0.1a0-py3-none-any.whl"],
    ["remote_skills-0.0.1-py3-none-any.whl"],
    [wheel, "extra.whl"],
  ]) {
    assert.throws(
      () => selectPythonWheel(built, '[project]\nversion = "0.0.1a0"\n'),
      /expected single wheel/u,
    );
  }
});

test("cache discovery preserves exact Windows environment and argument bytes", () => {
  const environment = uvCacheQueryEnvironment({
    UV_CACHE_DIR: windowsCache,
    XDG_CACHE_HOME: "/ignored",
  });
  const probe = runCommand(
    process.execPath,
    [
      "-e",
      `process.stdout.write(JSON.stringify({
        argv: process.argv.slice(1),
        cache: process.env.UV_CACHE_DIR,
        xdg: process.env.XDG_CACHE_HOME ?? null,
      }))`,
      ...uvCacheDirectoryArguments,
    ],
    { encoding: "utf8", env: environment },
  );

  assert.equal(probe.status, 0, probe.stderr);
  const output: unknown = JSON.parse(probe.stdout);
  assert.deepEqual(output, {
    argv: expectedArguments,
    cache: windowsCache,
    xdg: null,
  });
});

test("cache discovery rejects color-decorated Windows paths", () => {
  const decorated = `\u001b[36m${windowsCache}\u001b[39m\r\n`;

  assert.throws(
    () => parseUvCacheDirectory(decorated, { platform: "win32" }),
    /one plain absolute path/u,
  );
});

test("the real uv child returns one parser-safe absolute cache path", () => {
  const probe = runCommand("uv", uvCacheDirectoryArguments, {
    encoding: "utf8",
    env: uvCacheQueryEnvironment(process.env),
  });

  assert.equal(probe.status, 0, probe.stderr);
  const cache = parseUvCacheDirectory(probe.stdout);
  assert.equal(isAbsolute(cache), true);
});
