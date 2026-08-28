import { NextResponse } from "next/server";
import { getAccountFromRequest } from "@/lib/auth";
import {
  alreadyPlayedMessage,
  castAnonymousVote,
  toggleVote,
} from "@/lib/sessions";
import { getAnonymousVoterId } from "@/lib/voters";

export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params;
    const account = getAccountFromRequest(request);
    const anonymousVoterId = getAnonymousVoterId(request);
    if (!account && !anonymousVoterId) {
      return NextResponse.json(
        { error: "This browser needs a voter ID." },
        { status: 401 },
      );
    }

    const body = (await request.json()) as {
      trackId?: unknown;
      enabled?: unknown;
    };

    if (typeof body.trackId !== "string") {
      return NextResponse.json(
        { error: "The vote is not valid." },
        { status: 400 },
      );
    }
    if (typeof body.enabled !== "boolean") {
      return NextResponse.json(
        { error: "The vote state is not valid." },
        { status: 400 },
      );
    }
    if (!account && !body.enabled) {
      return NextResponse.json(
        { error: "The anonymous free vote cannot be removed." },
        { status: 400 },
      );
    }

    const result = account
      ? toggleVote({
          sessionId: id,
          trackId: body.trackId,
          accountId: account.id,
          enabled: body.enabled,
        })
      : castAnonymousVote({
          sessionId: id,
          trackId: body.trackId,
          voterId: anonymousVoterId as string,
        });

    if (result && "status" in result && result.status === "already_played") {
      return NextResponse.json(
        { error: alreadyPlayedMessage, code: "ALREADY_PLAYED" },
        { status: 409 },
      );
    }

    if (result && "status" in result && result.status === "phone_required") {
      return NextResponse.json(
        {
          error: "Add your phone number to vote again.",
          code: "PHONE_REQUIRED",
        },
        { status: 403 },
      );
    }

    if (!result || ("status" in result && result.status === "not_found")) {
      return NextResponse.json(
        { error: "The room or track could not be found." },
        { status: 404 },
      );
    }

    if ("status" in result) {
      return NextResponse.json({ session: result.session, voted: result.voted });
    }
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof Error && error.message === alreadyPlayedMessage) {
      return NextResponse.json(
        { error: alreadyPlayedMessage, code: "ALREADY_PLAYED" },
        { status: 409 },
      );
    }
    return NextResponse.json(
      { error: "The vote could not be saved." },
      { status: 500 },
    );
  }
}
