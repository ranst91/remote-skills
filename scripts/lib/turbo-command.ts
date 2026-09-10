import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const defaultTurboCli = require.resolve("turbo/bin/turbo");

export function createTurboCommand(
  args: readonly string[],
  {
    nodeExecutable = process.execPath,
    turboCli = defaultTurboCli,
  }: { nodeExecutable?: string; turboCli?: string } = {},
): { command: string; args: string[] } {
  return {
    command: nodeExecutable,
    args: [turboCli, ...args],
  };
}
