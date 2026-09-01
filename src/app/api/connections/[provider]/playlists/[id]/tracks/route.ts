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
  context: { params: Promise<{ provider: string; id: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  const { provider: providerId, id } = await context.params;
  const provider = getProvider(providerId);
  if (!provider) {
    return NextResponse.json({ error: "Unknown service." }, { status: 404 });
  }

  const limited = guardProviderRequest(request, account.id);
  if (limited) return limited;

  // Capped like every other search in the app (libraries.ts caps at 100).
  const query = (new URL(request.url).searchParams.get("q") ?? "").slice(0, 100);

  try {
    const accessToken = await getAccessToken(account.id, provider);
    const tracks = await provider.listPlaylistTracks(accessToken, id, { query });
    // A blocked track has no audio anywhere, so it is never offered: the DJ
    // asked for a set the room can actually hear.
    return NextResponse.json(
      { tracks: tracks.filter((track) => track.access !== "blocked") },
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
