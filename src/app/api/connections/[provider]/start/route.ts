import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import { ConnectionsUnavailableError, startConnection } from "@/lib/connections";
import { getProvider } from "@/lib/providers";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ provider: string }> },
) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json(
      { error: "Sign in before connecting an account." },
      { status: 401 },
    );
  }

  const provider = getProvider((await context.params).provider);
  if (!provider) {
    return NextResponse.json({ error: "Unknown service." }, { status: 404 });
  }

  try {
    return NextResponse.json(startConnection({ accountId: account.id, provider }));
  } catch (error) {
    if (error instanceof ConnectionsUnavailableError) {
      return NextResponse.json({ error: error.message }, { status: 503 });
    }
    return NextResponse.json(
      { error: "The connection could not be started." },
      { status: 500 },
    );
  }
}
