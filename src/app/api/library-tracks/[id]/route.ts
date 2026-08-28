import { NextResponse } from "next/server";
import { isAdminConfigured, isAdminRequest } from "@/lib/admin";
import { deleteLibraryTrack } from "@/lib/libraries";

export const dynamic = "force-dynamic";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  // Anyone may contribute, so removal is the moderation lever and stays with
  // the admin.
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { error: "The admin area is not configured on this server." },
      { status: 404 },
    );
  }
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  const { id } = await context.params;
  if (deleteLibraryTrack(id) === 0) {
    return NextResponse.json({ error: "No such song." }, { status: 404 });
  }
  return NextResponse.json({ deleted: true });
}
