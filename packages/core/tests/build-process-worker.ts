import fs, { existsSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { setTimeout as delay } from "node:timers/promises";

import { buildPublisherOutput } from "../src/build/index.ts";
import { validateConfig } from "../src/config-schema.ts";

const [projectDir, name, readyPath, barrierPath, schedule] = process.argv.slice(2);
if (!projectDir || !name || !readyPath || !barrierPath) process.exit(2);
async function waitForBarrier(target: string) {
  const deadline = Date.now() + 10_000;
  while (!existsSync(target)) {
    if (Date.now() >= deadline) throw new Error("publisher worker barrier timed out");
    await delay(2);
  }
}

if (schedule === "pause-writer-staging") {
  const originalOpen = fs.promises.open;
  let paused = false;
  fs.promises.open = async (target, flags, ...arguments_) => {
    const handle = await originalOpen(target, flags, ...arguments_);
    if (
      paused ||
      !String(target).endsWith(".pending") ||
      typeof flags !== "number" ||
      (flags & fs.constants.O_CREAT) === 0
    ) {
      return handle;
    }
    paused = true;
    const writeFile = handle.writeFile.bind(handle);
    handle.writeFile = async (...args) => {
      const signalPath = `${readyPath}.pending`;
      const temporarySignalPath = `${signalPath}.tmp`;
      const signal = await originalOpen(temporarySignalPath, "wx");
      try {
        writeFileSync(`${readyPath}.pending-created`, "created\n");
        await waitForBarrier(`${barrierPath}.signal`);
        await signal.writeFile(String(target));
      } finally {
        await signal.close();
      }
      await fs.promises.rename(temporarySignalPath, signalPath);
      await waitForBarrier(`${barrierPath}.write`);
      await writeFile(...args);
      writeFileSync(`${readyPath}.written`, "written\n");
      await waitForBarrier(`${barrierPath}.publish`);
    };
    return handle;
  };
  syncBuiltinESMExports();
}
const markdown = Buffer.from(
  `---\nname: ${name}\ndescription: Concurrently build ${name}.\n---\n${"x".repeat(4_000_000)}\n`,
);
writeFileSync(readyPath, "ready\n");
await waitForBarrier(barrierPath);
await buildPublisherOutput({
  projectDir,
  config: validateConfig({}),
  validation: {
    valid: true,
    skills: [
      {
        name,
        description: `Concurrently build ${name}.`,
        frontmatter: {},
        files: [{ path: "SKILL.md", bytes: markdown, size: markdown.byteLength }],
      },
    ],
  },
});
