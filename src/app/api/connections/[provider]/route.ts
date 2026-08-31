import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { disconnect } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function DELETE(
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

  disconnect(account.id, provider.id);
  // Idempotent: disconnecting something already gone is a success, so a
  // double tap on a slow connection does not surface an error.
  return NextResponse.json({ disconnected: true });
}
