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
  releaseRateLimit,
  takeRateLimit,
} from "@/lib/rate-limit";
import { getAnonymousVoterId } from "@/lib/voters";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  // This route is an oracle (404 unknown number, 200 + token known number),
  // so it is throttled per address; see rate-limit.ts. Only the misses stay
  // counted: a sweep is made of misses, a crowd logging in is not.
  const clientAddress = getClientAddress(request);
  const retryAfter = takeRateLimit("accounts", clientAddress);
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

    // The browser's free vote carries over to this account unless the
    // browser already belongs to another one — a phone passed around a
    // table — in which case there is simply nothing to carry over. Either
    // way the login goes through: refusing it left that browser with no
    // way in at all.
    const voterId = getAnonymousVoterId(request);
    if (voterId) {
      claimAnonymousVoter({ accountId: account.id, voterId, onLinkedElsewhere: "skip" });
    }

    releaseRateLimit("accounts", clientAddress);
    return NextResponse.json({
      account: toPublicAccount(account),
      token: account.authToken,
    });
  } catch {
    return NextResponse.json(
      { error: "The account could not be logged in." },
      { status: 500 },
    );
  }
}
