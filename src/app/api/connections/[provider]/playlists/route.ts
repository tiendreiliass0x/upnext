import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import {
  getAccessToken,
  guardProviderRequest,
  ReconnectRequiredError,
} from "@/lib/connections";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const provider = getProvider((await context.params).provider);
  if (!provider) {
    return NextResponse.json({ error: "Unknown service." }, { status: 404 });
  }

  const limited = guardProviderRequest(request, account.id);
  if (limited) return limited;

  try {
    const accessToken = await getAccessToken(account.id, provider);
    return NextResponse.json(
      { playlists: await provider.listPlaylists(accessToken) },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ReconnectRequiredError) {
      return NextResponse.json(
        { error: `Reconnect ${provider.label} to keep using it.`, code: "RECONNECT" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: `${provider.label} could not be reached.` },
      { status: 502 },
    );
  }
}
