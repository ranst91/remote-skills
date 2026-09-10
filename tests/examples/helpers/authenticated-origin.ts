import { timingSafeEqual } from "node:crypto";

import {
  type StaticOriginAuthorizer,
  startStaticOrigin,
  staticResourceKind,
} from "./static-host.ts";

interface ScopedAuthorizationOptions {
  token: string;
  scope: string;
}

interface AuthenticatedOriginOptions {
  root: string;
  token: string;
  scope?: string;
  port?: number;
}

function sameText(left: string, right: string) {
  const leftBytes = Buffer.from(left);
  const rightBytes = Buffer.from(right);
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

export function scopedAuthorization({
  token,
  scope,
}: ScopedAuthorizationOptions): StaticOriginAuthorizer {
  if (token.length === 0) throw new Error("authenticated origin requires a non-empty token");
  return ({ pathname, request }) => {
    const kind = staticResourceKind(pathname);
    if (kind === null) return { status: 403 };
    const isCatalog = kind === "catalog";
    const authorization = request.headers.authorization ?? "";
    if (!sameText(authorization, `Bearer ${token}`)) {
      return { status: 401, headers: { "WWW-Authenticate": "Bearer" } };
    }
    if (isCatalog && request.headers["remote-skills-scope"] !== scope) {
      return { status: 403 };
    }
    return isCatalog
      ? { headers: { "Remote-Skills-Scope": scope } }
      : { headers: { "Cache-Control": "private, no-store" } };
  };
}

export function startAuthenticatedOrigin({
  root,
  token,
  scope = "engineering",
  port = 0,
}: AuthenticatedOriginOptions) {
  return startStaticOrigin({ root, port, authorize: scopedAuthorization({ token, scope }) });
}
