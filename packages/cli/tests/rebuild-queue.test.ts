import assert from "node:assert/strict";
import { test } from "node:test";

import { createSingleFlightRebuilder } from "../src/rebuild-queue.ts";
import { completesWithin } from "./helpers/async.ts";

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve = () => {};
  const promise = new Promise<void>((promiseResolve) => {
    resolve = () => promiseResolve();
  });
  return { promise, resolve };
}

async function waitFor(predicate: () => boolean, description: string): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 500) assert.fail(`timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

test("coalesces rapid churn into one pending rebuild while a rebuild is active", async () => {
  const firstBuild = deferred();
  const secondBuild = deferred();
  const gates = [firstBuild, secondBuild];
  const attemptedGenerations: number[] = [];
  let desiredGeneration = 1;
  const rebuilder = createSingleFlightRebuilder(async () => {
    const attempt = attemptedGenerations.length;
    attemptedGenerations.push(desiredGeneration);
    const gate = gates[attempt];
    if (gate === undefined) throw new Error("unexpected rebuild attempt");
    await gate.promise;
  });

  rebuilder.request();
  await waitFor(() => attemptedGenerations.length === 1, "the first rebuild");
  for (desiredGeneration = 2; desiredGeneration <= 100; desiredGeneration += 1) {
    rebuilder.request();
  }
  desiredGeneration = 100;
  firstBuild.resolve();
  await waitFor(() => attemptedGenerations.length === 2, "the coalesced rebuild");
  secondBuild.resolve();
  await rebuilder.whenIdle();

  assert.deepEqual(attemptedGenerations, [1, 100]);
});

test("shutdown cancels a dirty rerun and waits only for the active rebuild", async () => {
  const activeBuild = deferred();
  let attempts = 0;
  const rebuilder = createSingleFlightRebuilder(async () => {
    attempts += 1;
    await activeBuild.promise;
  });

  rebuilder.request();
  await waitFor(() => attempts === 1, "the active rebuild");
  for (let change = 0; change < 100; change += 1) rebuilder.request();
  const closing = rebuilder.close();
  activeBuild.resolve();
  await completesWithin(closing, 250, "single-flight shutdown did not complete promptly");
  rebuilder.request();
  await new Promise((resolve) => setTimeout(resolve, 10));

  assert.equal(attempts, 1);
});
