import { NextResponse } from "next/server";
import {
  createAccount,
  getAccountByCreationRequest,
  getAccountByPhone,
  normalizePhone,
  toPublicAccount,
  updateAccountPseudonym,
} from "@/lib/accounts";
import { getAccountFromRequest } from "@/lib/auth";
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
        { error: "Choose a pseudonym between 2 and 24 characters." },
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
      return NextResponse.json(
        {
          error:
            "This phone already has an account. Log in instead.",
        },
        { status: 409 },
      );
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
