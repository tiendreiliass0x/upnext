import { getAccountByToken } from "@/lib/accounts";

export function getAccountFromRequest(request: Request) {
  const authorization = request.headers.get("authorization") ?? "";
  const token = authorization.startsWith("Bearer ")
    ? authorization.slice(7).trim()
    : request.headers.get("x-upnext-account-token")?.trim() ?? "";
  return getAccountByToken(token);
}
