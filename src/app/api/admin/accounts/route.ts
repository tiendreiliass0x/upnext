import { NextResponse } from "next/server";
import { listAccountStatuses } from "@/lib/accounts";
import { isAdminConfigured, isAdminRequest } from "@/lib/admin";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { error: "The admin area is not configured on this server." },
      { status: 404 },
    );
  }
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }
  return NextResponse.json({ accounts: listAccountStatuses() });
}
