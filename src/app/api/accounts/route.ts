import { NextResponse } from "next/server";
import {
  claimAnonymousVoter,
  createAccount,
  getAccountByCreationRequest,
  getAccountByPhone,
  normalizePhone,
  toPublicAccount,
  updateAccountPseudonym,
  voterLinkedElsewhereMessage,
} from "@/lib/accounts";
import { getAccountFromRequest } from "@/lib/auth";
import {
  getClientAddress,
  rateLimitedResponse,
  releaseRateLimit,
  takeRateLimit,
} from "@/lib/rate-limit";
import {
  getAnonymousVoterId,
  normalizeAnonymousVoterId,
} from "@/lib/voters";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  return NextResponse.json({ account: toPublicAccount(account) });
}

export async function POST(request: Request) {
  const clientAddress = getClientAddress(request);
  const retryAfter = takeRateLimit("accounts", clientAddress);
  if (retryAfter !== null) return rateLimitedResponse(retryAfter);

  try {
    const body = (await request.json()) as {
      phone?: unknown;
      pseudonym?: unknown;
      requestId?: unknown;
    };
    const phone =
      typeof body.phone === "string" ? normalizePhone(body.phone) : null;
    const pseudonym =
      typeof body.pseudonym === "string" ? body.pseudonym.trim() : "";

    if (!phone) {
      return NextResponse.json(
        { error: "Enter a phone number with its country code." },
        { status: 400 },
      );
    }

    if (pseudonym.length < 2 || pseudonym.length > 24) {
      return NextResponse.json(
        { error: "Choose a username between 2 and 24 characters." },
        { status: 400 },
      );
    }

    const anonymousVoterId = getAnonymousVoterId(request);
    const requestId = normalizeAnonymousVoterId(body.requestId);
    if (body.requestId !== undefined && !requestId) {
      return NextResponse.json(
        { error: "The account request ID is not valid." },
        { status: 400 },
      );
    }
    const retriedAccount =
      anonymousVoterId && requestId
        ? getAccountByCreationRequest({ requestId, voterId: anonymousVoterId })
        : null;
    if (retriedAccount) {
      if (retriedAccount.phone !== phone) {
        return NextResponse.json(
          { error: "This account request was already used." },
          { status: 409 },
        );
      }
      return NextResponse.json({
        account: toPublicAccount(retriedAccount),
        token: retriedAccount.authToken,
      });
    }
    const existing = getAccountByPhone(phone);
    const authenticatedAccount = getAccountFromRequest(request);
    if (existing && authenticatedAccount?.id !== existing.id) {
      // Login is phone-only and unverified, so a known number on the sign-up
      // form clears the same bar as the login form: treat it as the login it
      // is rather than send the guest to find the other form. The pseudonym
      // typed here is dropped — knowing a number must not rename its owner.
      // The browser's free vote carries over unless this browser already
      // belongs to someone else, in which case there is nothing to carry.
      if (anonymousVoterId) {
        claimAnonymousVoter({
          accountId: existing.id,
          voterId: anonymousVoterId,
          onLinkedElsewhere: "skip",
        });
      }
      // A login that succeeded is not an enumeration probe.
      releaseRateLimit("accounts", clientAddress);
      return NextResponse.json({
        account: toPublicAccount(existing),
        token: existing.authToken,
        loggedIn: true,
      });
    }

    const account = existing
      ? updateAccountPseudonym(existing, pseudonym)
      : createAccount({
          phone,
          pseudonym,
          anonymousVoterId,
          requestId,
        });
    return NextResponse.json({
      account: toPublicAccount(account),
      token: account.authToken,
    });
  } catch (error) {
    if (error instanceof Error && error.message === voterLinkedElsewhereMessage) {
      return NextResponse.json({ error: error.message }, { status: 409 });
    }
    if (
      error instanceof Error &&
      error.message.toLowerCase().includes("unique")
    ) {
      return NextResponse.json(
        {
          error:
            "This phone already has an account. Log in instead.",
        },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "Your account could not be saved." },
      { status: 500 },
    );
  }
}
