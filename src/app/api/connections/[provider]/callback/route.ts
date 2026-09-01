import { NextResponse } from "next/server";
import { getPublicBaseUrl } from "@/lib/config";
import { completeConnection, ConnectionsUnavailableError } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * Where the provider sends the DJ back to.
 *
 * Deliberately unauthenticated, and it has to be: this is a top-level
 * navigation from another origin, so it carries no bearer header and this app
 * has no cookies. The oauth_states row is what identifies the account, which
 * is why that row is single use and short lived.
 *
 * It never renders a result itself. Everything lands on /connect-done, which
 * closes the popup the booth opened; the outcome travels as a short status
 * code rather than as provider text, so nothing from the far side of the
 * redirect reaches the page.
 */
function landing(base: string, provider: string, status: string) {
  const url = new URL(`${base}/connect-done`);
  url.searchParams.set("provider", provider);
  url.searchParams.set("status", status);
  return NextResponse.redirect(url.toString(), { status: 303 });
}

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const { provider: providerId } = await context.params;
  const base = getPublicBaseUrl();
  if (!base) {
    return NextResponse.json(
      { error: "Set APP_PUBLIC_URL before connecting an account." },
      { status: 503 },
    );
  }

  const provider = getProvider(providerId);
  if (!provider) return landing(base, providerId, "unknown");

  const params = new URL(request.url).searchParams;
  // The DJ pressed Cancel at the provider, or the provider refused.
  if (params.get("error")) return landing(base, provider.id, "denied");

  const code = params.get("code") ?? "";
  const state = params.get("state") ?? "";
  if (!code || !state) return landing(base, provider.id, "invalid");

  try {
    await completeConnection({ provider, code, state });
    return landing(base, provider.id, "ok");
  } catch (error) {
    if (error instanceof ConnectionsUnavailableError) {
      return landing(base, provider.id, "expired");
    }
    return landing(base, provider.id, "failed");
  }
}
