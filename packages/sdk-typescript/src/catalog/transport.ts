import { Resolver } from "node:dns/promises";
import { type IncomingMessage, request as requestHttp } from "node:http";
import { request as requestHttps } from "node:https";

import type { ResolvedAddress, ResolveHost } from "./network-policy.ts";

export interface TransportRequest {
  url: string;
  headers: Readonly<Record<string, string>>;
  address: ResolvedAddress;
  signal: AbortSignal;
  maxBytes: number;
}

export interface TransportResponse {
  status: number;
  headers: Readonly<Record<string, string>>;
  body: Uint8Array;
}

export type HttpTransport = (request: TransportRequest) => Promise<TransportResponse>;

export class RequestTimedOut extends Error {}
export class ResponseLimitExceeded extends Error {}

interface CancellableResolver {
  resolve4(hostname: string): Promise<readonly string[]>;
  resolve6(hostname: string): Promise<readonly string[]>;
  cancel(): void;
}

export function createDefaultResolveHost(
  createResolver: () => CancellableResolver = () => new Resolver(),
): ResolveHost {
  return async (hostname, signal) => {
    if (signal.aborted) throw signal.reason;
    if (hostname.toLowerCase() === "localhost") {
      return [
        { address: "127.0.0.1", family: 4 },
        { address: "::1", family: 6 },
      ];
    }

    const resolver = createResolver();
    const cancel = () => resolver.cancel();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      const [ipv4, ipv6] = await Promise.allSettled([
        resolver.resolve4(hostname),
        resolver.resolve6(hostname),
      ]);
      if (signal.aborted) throw signal.reason;
      const answers: ResolvedAddress[] = [];
      if (ipv4.status === "fulfilled") {
        answers.push(...ipv4.value.map((address) => ({ address, family: 4 as const })));
      }
      if (ipv6.status === "fulfilled") {
        answers.push(...ipv6.value.map((address) => ({ address, family: 6 as const })));
      }
      if (answers.length > 0) return answers;
      if (ipv4.status === "rejected") throw ipv4.reason;
      if (ipv6.status === "rejected") throw ipv6.reason;
      return answers;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  };
}

export const defaultResolveHost = createDefaultResolveHost();

function responseHeaders(
  headers: NodeJS.Dict<string | string[]>,
): Readonly<Record<string, string>> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === "string") normalized[name.toLowerCase()] = value;
    else if (Array.isArray(value)) normalized[name.toLowerCase()] = value.join(", ");
  }
  return normalized;
}

export function consumeResponse(
  response: IncomingMessage,
  maxBytes: number,
): Promise<TransportResponse> {
  return new Promise((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    response.on("error", reject);
    response.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        response.destroy(new ResponseLimitExceeded());
        return;
      }
      chunks.push(chunk);
    });
    response.on("end", () => {
      resolve({
        status: response.statusCode ?? 0,
        headers: responseHeaders(response.headers),
        body: Buffer.concat(chunks, size),
      });
    });

    const declaredLength = Number(response.headers["content-length"]);
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      response.destroy(new ResponseLimitExceeded());
    }
  });
}

export const defaultTransport: HttpTransport = async (input) =>
  new Promise((resolve, reject) => {
    const url = new URL(input.url);
    const request = (url.protocol === "https:" ? requestHttps : requestHttp)(
      url,
      {
        method: "GET",
        headers: input.headers,
        signal: input.signal,
        lookup: (_hostname, options, callback) => {
          if (options.all) {
            callback(null, [input.address]);
          } else {
            callback(null, input.address.address, input.address.family);
          }
        },
      },
      (response) => {
        void consumeResponse(response, input.maxBytes).then(resolve, reject);
      },
    );
    request.on("error", reject);
    request.end();
  });
