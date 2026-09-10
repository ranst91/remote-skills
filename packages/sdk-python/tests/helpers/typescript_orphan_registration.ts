import { DiskCache } from "../../../sdk-typescript/src/cache/index.ts";

const [root, digest] = process.argv.slice(2);
if (root === undefined || !/^sha256:[0-9a-f]{64}$/u.test(digest ?? "")) {
  throw new Error("usage: typescript_orphan_registration.ts <root> <digest>");
}
if (digest === undefined) throw new Error("digest argument is missing");

async function main(validRoot: string, validDigest: string): Promise<void> {
  await new DiskCache({
    directory: validRoot,
    processNonce: "typescript-orphan-before-publication",
    renewIntervalSeconds: 0,
    coordinationHooks: {
      afterLeaseDirectoryPrepared: () => process.exit(0),
    },
  }).acquireLease(validDigest, "never-published");

  throw new Error("orphan crash hook was not reached");
}

void main(root, digest);
