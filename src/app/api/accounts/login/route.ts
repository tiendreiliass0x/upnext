import { NextResponse } from "next/server";
import {
  claimAnonymousVoter,
  getAccountByPhone,
  normalizePhone,
  toPublicAccount,
} from "@/lib/accounts";
import {
  getClientAddress,
  rateLimitedResponse,
  takeRateLimit,
} from "@/lib/rate-limit";
import { getAnonymousVoterId } from "@/lib/voters";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // This route is an oracle (404 unknown number, 200 + token known number),
  // so it is throttled per address; see rate-limit.ts.
  const retryAfter = takeRateLimit("accounts", getClientAddress(request));
  if (retryAfter !== null) return rateLimitedResponse(retryAfter);

  try {
    const body = (await request.json()) as { phone?: unknown };
    const phone =
      typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    if (!phone) {
      return NextResponse.json(
        { error: "Enter a phone number with its country code." },
        { status: 400 },
      );
    }

    const account = getAccountByPhone(phone);
    if (!account) {
      return NextResponse.json(
        { error: "No account was found for this phone number." },
        { status: 404 },
      );
    }

    const voterId = getAnonymousVoterId(request);
    if (voterId) {
      claimAnonymousVoter({ accountId: account.id, voterId });
    }

    return NextResponse.json({
      account: toPublicAccount(account),
      token: account.authToken,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("voter ID")) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    return NextResponse.json(
      { error: "The account could not be logged in." },
      { status: 500 },
    );
  }
}
