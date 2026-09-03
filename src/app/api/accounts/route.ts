import { NextResponse } from "next/server";
import {
  claimAnonymousVoter,
  createAccount,
  getAccountByCreationRequest,
  getAccountByPhone,
  normalizePhone,
  toPublicAccount,
  updateAccountProfile,
  voterLinkedElsewhereMessage,
} from "@/lib/accounts";
import { pseudonymError, taglineError } from "@/lib/profile";
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

/**
 * Edit the profile of the account this token belongs to. Distinct from POST,
 * which is the sign-up form and identifies an account by its phone number: a
 * rename has to prove it owns the account, not merely know the number.
 *
 * Fields are optional and independent, so the form can send the one it
 * touched. Whatever the caller sends, phone and token are not on the list —
 * they are the credential, not the profile.
 */
export async function PATCH(request: Request) {
  const account = getAccountFromRequest(request);
  if (!account) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }

  let body: { pseudonym?: unknown; tagline?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "Your profile could not be saved." },
      { status: 400 },
    );
  }
  // A body of literal `null` parses fine and is not an object; reading a field
  // off it would throw outside the try above.
  if (!body || typeof body !== "object") {
    return NextResponse.json(
      { error: "Your profile could not be saved." },
      { status: 400 },
    );
  }

  const changes: { pseudonym?: string; tagline?: string } = {};
  if (body.pseudonym !== undefined) {
    if (typeof body.pseudonym !== "string") {
      return NextResponse.json(
        { error: "Your username has to be text." },
        { status: 400 },
      );
    }
    const message = pseudonymError(body.pseudonym);
    if (message) return NextResponse.json({ error: message }, { status: 400 });
    changes.pseudonym = body.pseudonym;
  }
  if (body.tagline !== undefined) {
    if (typeof body.tagline !== "string") {
      return NextResponse.json(
        { error: "Your tagline has to be text." },
        { status: 400 },
      );
    }
    const message = taglineError(body.tagline);
    if (message) return NextResponse.json({ error: message }, { status: 400 });
    changes.tagline = body.tagline;
  }

  try {
    const updated = updateAccountProfile(account, changes);
    return NextResponse.json({ account: toPublicAccount(updated) });
  } catch {
    return NextResponse.json(
      { error: "Your profile could not be saved." },
      { status: 500 },
    );
  }
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

    const pseudonymMessage = pseudonymError(pseudonym);
    if (pseudonymMessage) {
      return NextResponse.json({ error: pseudonymMessage }, { status: 400 });
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
      ? updateAccountProfile(existing, { pseudonym })
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
