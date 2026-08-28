import { NextResponse } from "next/server";
import { isAdminConfigured, isAdminRequest } from "@/lib/admin";
import { getAccountFromRequest } from "@/lib/auth";
import { createLibrary, listLibraries } from "@/lib/libraries";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  // Any signed-in DJ may browse the catalogue; only an admin may change it.
  if (!getAccountFromRequest(request) && !isAdminRequest(request)) {
    return NextResponse.json({ error: "Sign in to continue." }, { status: 401 });
  }
  return NextResponse.json({ libraries: listLibraries() });
}

export async function POST(request: Request) {
  if (!isAdminConfigured()) {
    return NextResponse.json(
      { error: "The admin area is not configured on this server." },
      { status: 404 },
    );
  }
  if (!isAdminRequest(request)) {
    return NextResponse.json({ error: "Admin access required." }, { status: 403 });
  }

  try {
    const body = (await request.json()) as {
      name?: unknown;
      description?: unknown;
    };
    const name = typeof body.name === "string" ? body.name.trim() : "";
    const description =
      typeof body.description === "string" ? body.description.trim() : "";

    if (name.length < 1 || name.length > 80) {
      return NextResponse.json(
        { error: "Give the library a name of 1 to 80 characters." },
        { status: 400 },
      );
    }

    return NextResponse.json(
      { library: createLibrary({ name, description: description.slice(0, 200) }) },
      { status: 201 },
    );
  } catch {
    return NextResponse.json(
      { error: "The library could not be created." },
      { status: 500 },
    );
  }
}
