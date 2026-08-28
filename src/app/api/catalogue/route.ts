import { NextResponse } from "next/server";
import { isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { searchCatalogue } from "@/lib/libraries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!getAccountFromRequest(request) && !isAdminRequest(request)) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  const query = new URL(request.url).searchParams.get("q") ?? "";
  return NextResponse.json({
    tracks: searchCatalogue({ query: query.slice(0, 100) }),
  });
}
