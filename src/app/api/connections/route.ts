import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { connectionsUnavailableReason, listConnections } from "@/lib/connections";
import { configuredProviders } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  // The picker needs both halves: which services this server could connect to
  // at all, and which this DJ already has. An unavailable one is reported with
  // its reason so the UI can explain itself rather than showing a dead button.
  const available = configuredProviders().map((provider) => ({
    provider: provider.id,
    label: provider.label,
    unavailableReason: connectionsUnavailableReason(provider),
  }));

  return NextResponse.json({
    available,
    connections: listConnections(account.id),
  });
}
