export type CacheRaceRuntime = "node" | "python";
export type CacheRaceOperation =
  | "active-pin"
  | "corruption"
  | "download"
  | "lease-expiry"
  | "stage-crash";

export interface CacheRaceSchedule {
  name: string;
  operation: CacheRaceOperation;
  primary: CacheRaceRuntime;
  secondary: CacheRaceRuntime;
}

const crossRuntime = (
  name: string,
  operation: CacheRaceOperation,
  primary: CacheRaceRuntime,
  secondary: CacheRaceRuntime,
): Readonly<CacheRaceSchedule> => Object.freeze({ name, operation, primary, secondary });

export const CACHE_RACE_SCHEDULES = Object.freeze([
  crossRuntime("node-download-wins", "download", "node", "python"),
  crossRuntime("python-download-wins", "download", "python", "node"),
  crossRuntime("node-stage-crash-python-recovers", "stage-crash", "node", "python"),
  crossRuntime("python-stage-crash-node-recovers", "stage-crash", "python", "node"),
  crossRuntime("node-expired-lease-python-reclaims", "lease-expiry", "node", "python"),
  crossRuntime("python-expired-lease-node-reclaims", "lease-expiry", "python", "node"),
  crossRuntime("node-pin-python-evicts", "active-pin", "node", "python"),
  crossRuntime("python-pin-node-evicts", "active-pin", "python", "node"),
  crossRuntime("node-publishes-python-rejects-corruption", "corruption", "node", "python"),
  crossRuntime("python-publishes-node-rejects-corruption", "corruption", "python", "node"),
]);
