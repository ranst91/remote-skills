import { isIP } from "node:net";

import type { NormalizedOrigin } from "../origin.ts";
import { RemoteSkillsError } from "./errors.ts";

export interface ResolvedAddress {
  address: string;
  family: 4 | 6;
}

export type ResolveHost = (
  hostname: string,
  signal: AbortSignal,
) => Promise<readonly ResolvedAddress[]>;

function ipv4Value(address: string): number | undefined {
  if (isIP(address) !== 4) return undefined;
  const octets = address.split(".").map(Number);
  const a = octets[0];
  const b = octets[1];
  const c = octets[2];
  const d = octets[3];
  if (a === undefined || b === undefined || c === undefined || d === undefined) return undefined;
  return (((a * 256 + b) * 256 + c) * 256 + d) >>> 0;
}

function inIpv4Range(value: number, base: number, prefix: number): boolean {
  const mask = prefix === 0 ? 0 : (0xffff_ffff << (32 - prefix)) >>> 0;
  return (value & mask) >>> 0 === (base & mask) >>> 0;
}

function isPublicIpv4(address: string): boolean {
  const value = ipv4Value(address);
  if (value === undefined) return false;
  const denied: readonly [number, number][] = [
    [0x0000_0000, 8],
    [0x0a00_0000, 8],
    [0x6440_0000, 10],
    [0x7f00_0000, 8],
    [0xa9fe_0000, 16],
    [0xac10_0000, 12],
    [0xc000_0000, 24],
    [0xc000_0200, 24],
    [0xc058_6300, 24],
    [0xc0a8_0000, 16],
    [0xc612_0000, 15],
    [0xc633_6400, 24],
    [0xcb00_7100, 24],
    [0xe000_0000, 4],
    [0xf000_0000, 4],
  ];
  return !denied.some(([base, prefix]) => inIpv4Range(value, base, prefix));
}

function ipv6Value(address: string): bigint | undefined {
  if (address.includes("%")) return undefined;
  let normalized = address.toLowerCase();
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    const embedded = ipv4Value(normalized.slice(separator + 1));
    if (separator === -1 || embedded === undefined) return undefined;
    normalized = `${normalized.slice(0, separator)}:${(embedded >>> 16).toString(16)}:${(
      embedded & 0xffff
    ).toString(16)}`;
  }
  if (isIP(normalized) !== 6) return undefined;
  const [leftRaw, rightRaw, extra] = normalized.split("::");
  if (extra !== undefined) return undefined;
  const parseSide = (side: string | undefined): number[] | undefined => {
    if (!side) return [];
    const values: number[] = [];
    for (const part of side.split(":")) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) return undefined;
      values.push(Number.parseInt(part, 16));
    }
    return values;
  };
  const left = parseSide(leftRaw);
  const right = parseSide(rightRaw);
  if (!left || !right) return undefined;
  const hasCompression = normalized.includes("::");
  const missing = 8 - left.length - right.length;
  if ((!hasCompression && missing !== 0) || (hasCompression && missing < 1)) return undefined;
  const groups = [...left, ...Array.from({ length: missing }, () => 0), ...right];
  if (groups.length !== 8) return undefined;
  return groups.reduce((value, group) => (value << 16n) | BigInt(group), 0n);
}

export function canonicalIpAddress(address: string): string | undefined {
  const ipv4 = ipv4Value(address);
  if (ipv4 !== undefined) return `ipv4:${ipv4.toString(16).padStart(8, "0")}`;
  const ipv6 = ipv6Value(address);
  if (ipv6 !== undefined) return `ipv6:${ipv6.toString(16).padStart(32, "0")}`;
  return undefined;
}

function inIpv6Range(value: bigint, base: bigint, prefix: number): boolean {
  const shift = 128n - BigInt(prefix);
  return value >> shift === base >> shift;
}

// IANA IPv6 special-purpose and allocated global-unicast registries; unknown space stays denied.
const GLOBALLY_REACHABLE_IPV6_SPECIAL_PURPOSE: readonly [bigint, number][] = [
  [0x0064_ff9b_0000_0000_0000_0000_0000_0000n, 96],
  [0x2001_0001_0000_0000_0000_0000_0000_0001n, 128],
  [0x2001_0001_0000_0000_0000_0000_0000_0002n, 128],
  [0x2001_0001_0000_0000_0000_0000_0000_0003n, 128],
  [0x2001_0003_0000_0000_0000_0000_0000_0000n, 32],
  [0x2001_0004_0112_0000_0000_0000_0000_0000n, 48],
  [0x2001_0020_0000_0000_0000_0000_0000_0000n, 28],
  [0x2001_0030_0000_0000_0000_0000_0000_0000n, 28],
];

const ALLOCATED_GLOBAL_UNICAST_IPV6: readonly [bigint, number][] = [
  [0x2001_0200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0400_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0600_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0800_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_0c00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_0e00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1400_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_1800_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1a00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_1c00_0000_0000_0000_0000_0000_0000n, 22],
  [0x2001_2000_0000_0000_0000_0000_0000_0000n, 19],
  [0x2001_4000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4200_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4400_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4600_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4800_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4a00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_4c00_0000_0000_0000_0000_0000_0000n, 23],
  [0x2001_5000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2001_8000_0000_0000_0000_0000_0000_0000n, 19],
  [0x2001_a000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2001_b000_0000_0000_0000_0000_0000_0000n, 20],
  [0x2003_0000_0000_0000_0000_0000_0000_0000n, 18],
  [0x2400_0000_0000_0000_0000_0000_0000_0000n, 11],
  [0x2600_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2610_0000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2620_0000_0000_0000_0000_0000_0000_0000n, 23],
  [0x2630_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2800_0000_0000_0000_0000_0000_0000_0000n, 12],
  [0x2a00_0000_0000_0000_0000_0000_0000_0000n, 11],
  [0x2c00_0000_0000_0000_0000_0000_0000_0000n, 12],
];

const NON_GLOBAL_SPECIAL_PURPOSE_IPV6: readonly [bigint, number][] = [
  [0x2001_0db8_0000_0000_0000_0000_0000_0000n, 32],
];

function isPublicIpv6(address: string): boolean {
  const value = ipv6Value(address);
  if (value === undefined) return false;
  if (value >> 32n === 0xffffn) {
    const embedded = Number(value & 0xffff_ffffn);
    const dotted = [24, 16, 8, 0].map((shift) => (embedded >>> shift) & 0xff).join(".");
    return isPublicIpv4(dotted);
  }
  if (
    GLOBALLY_REACHABLE_IPV6_SPECIAL_PURPOSE.some(([base, prefix]) =>
      inIpv6Range(value, base, prefix),
    )
  ) {
    return true;
  }
  if (NON_GLOBAL_SPECIAL_PURPOSE_IPV6.some(([base, prefix]) => inIpv6Range(value, base, prefix))) {
    return false;
  }
  return ALLOCATED_GLOBAL_UNICAST_IPV6.some(([base, prefix]) => inIpv6Range(value, base, prefix));
}

export function isPublicAddress(address: string): boolean {
  if (isIP(address) === 4) return isPublicIpv4(address);
  if (isIP(address) === 6) {
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
    return mapped?.[1] ? isPublicIpv4(mapped[1]) : isPublicIpv6(address);
  }
  return false;
}

function policyDenied(origin: NormalizedOrigin): never {
  throw new RemoteSkillsError("policy_denied", { origin_alias: origin.alias });
}

export function isLoopbackAddress(address: string): boolean {
  const value = ipv4Value(address);
  if (value !== undefined) return inIpv4Range(value, 0x7f00_0000, 8);
  const ipv6 = ipv6Value(address);
  if (ipv6 === 1n) return true;
  if (ipv6 === undefined || ipv6 >> 32n !== 0xffffn) return false;
  return inIpv4Range(Number(ipv6 & 0xffff_ffffn), 0x7f00_0000, 8);
}

export function hasUrlQueryOrFragment(url: URL): boolean {
  return url.search !== "" || url.hash !== "" || url.href.includes("?") || url.href.includes("#");
}

function isAsciiControlOrSpace(codeUnit: number): boolean {
  return (codeUnit >= 0 && codeUnit <= 0x20) || codeUnit === 0x7f;
}

function hasCanonicalAuthoritySyntax(value: string): boolean {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(value);
  const schemeName = scheme?.[1]?.toLowerCase();
  if (scheme !== null && (schemeName === "http" || schemeName === "https")) {
    const authorityStart = scheme[0].length;
    return value.startsWith("//", authorityStart) && value[authorityStart + 2] !== "/";
  }
  return !value.startsWith("//") || value[2] !== "/";
}

export function isCanonicalRawUrlReference(value: string): boolean {
  const hasEdgeControl =
    isAsciiControlOrSpace(value.charCodeAt(0)) ||
    isAsciiControlOrSpace(value.charCodeAt(value.length - 1));
  const hasStrippedWhitespace =
    value.includes("\t") || value.includes("\n") || value.includes("\r");
  return (
    !hasEdgeControl &&
    !hasStrippedWhitespace &&
    !value.includes("\\") &&
    hasCanonicalAuthoritySyntax(value)
  );
}

export function hasRawUrlUserinfo(value: string): boolean {
  const schemeAuthority = /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.exec(value);
  const authorityStart = value.startsWith("//") ? 2 : schemeAuthority?.[0].length;
  if (authorityStart === undefined) return false;

  const remainder = value.slice(authorityStart);
  const delimiter = remainder.search(/[/?#]/);
  const authority = delimiter === -1 ? remainder : remainder.slice(0, delimiter);
  return authority.includes("@");
}

export async function resolveNetworkTarget(
  origin: NormalizedOrigin,
  url: URL,
  resolveHost: ResolveHost,
  signal: AbortSignal = new AbortController().signal,
): Promise<ResolvedAddress> {
  if (url.username || url.password || hasUrlQueryOrFragment(url)) policyDenied(origin);
  if (url.protocol !== "https:" && url.protocol !== "http:") policyDenied(origin);
  if (url.protocol === "http:" && !origin.allowLoopbackHttp) policyDenied(origin);

  const literalFamily = isIP(url.hostname.replace(/^\[|\]$/g, ""));
  const answers = literalFamily
    ? [
        {
          address: url.hostname.replace(/^\[|\]$/g, ""),
          family: literalFamily,
        } as ResolvedAddress,
      ]
    : await resolveHost(url.hostname, signal);
  if (answers.length === 0) policyDenied(origin);

  if (url.protocol === "http:") {
    if (!origin.allowLoopbackHttp || !answers.every(({ address }) => isLoopbackAddress(address))) {
      policyDenied(origin);
    }
    const selected = answers[0];
    if (!selected) policyDenied(origin);
    return selected;
  }

  for (const answer of answers) {
    const normalized = canonicalIpAddress(answer.address);
    const allowed =
      isPublicAddress(answer.address) ||
      (normalized !== undefined && origin.allowedAddresses.has(normalized));
    if (!allowed) policyDenied(origin);
  }
  const selected = answers[0];
  if (!selected) policyDenied(origin);
  return selected;
}
