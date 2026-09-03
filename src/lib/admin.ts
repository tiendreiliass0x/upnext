import { timingSafeEqual } from "node:crypto";

import { adminTokenHeader } from "@/lib/tokens";

export { adminTokenHeader };

/**
 * The admin surface is deliberately not built on phone accounts. Phone login is
 * unverified, so anyone who knows a registered number holds that account;
 * hanging the catalogue off it would make the most privileged surface the
 * easiest to take over. A separate secret keeps the two failure domains apart.
 */
export function isAdminConfigured() {
  return Boolean(process.env.ADMIN_TOKEN?.trim());
}

export function isAdminRequest(request: Request) {
  const configured = process.env.ADMIN_TOKEN?.trim();
  // Unset means the admin surface does not exist, rather than that it is open.
  if (!configured) return false;

  const presented = request.headers.get(adminTokenHeader)?.trim() ?? "";
  if (!presented) return false;

  const a = Buffer.from(presented);
  const b = Buffer.from(configured);
  // timingSafeEqual throws on a length mismatch, which would itself leak the
  // length, so compare a fixed-size digest-shaped pair instead.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
