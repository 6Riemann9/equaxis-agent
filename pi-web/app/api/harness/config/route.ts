import { NextResponse } from "next/server";
import { isAbsolute } from "node:path";
import { findEquaxisRoot, runEquaxisScript } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

// GET /api/harness/config?cwd=<root> -> layered settings (sections, layers, effective)
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim() ?? "";
  if (!cwd || !isAbsolute(cwd)) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  const root = findEquaxisRoot(cwd);
  if (!root) {
    return NextResponse.json({ error: "Not an Equaxis project (.pi/equaxis.json missing)" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(root, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }
  try {
    const snapshot = await runEquaxisScript(root, "config-edit.mjs", ["view", "--cwd", root]);
    return NextResponse.json(snapshot);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/harness/config body: { cwd, action: "set" | "unset", layer, key, value? }
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as {
      cwd?: unknown;
      action?: unknown;
      layer?: unknown;
      key?: unknown;
      value?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const action = body.action === "set" || body.action === "unset" ? body.action : null;
    const layer = body.layer === "project" || body.layer === "global" ? body.layer : null;
    const key = typeof body.key === "string" ? body.key.trim() : "";

    if (!cwd || !isAbsolute(cwd)) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!action) return NextResponse.json({ error: "action must be set or unset" }, { status: 400 });
    if (!layer) return NextResponse.json({ error: "layer must be project or global" }, { status: 400 });
    if (!key) return NextResponse.json({ error: "key required (dot path)" }, { status: 400 });

    const root = findEquaxisRoot(cwd);
    if (!root) {
      return NextResponse.json({ error: "Not an Equaxis project (.pi/equaxis.json missing)" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(root, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const args = [action, "--cwd", root, "--layer", layer, "--key", key];
    if (action === "set") {
      args.push("--value", JSON.stringify(body.value));
    }
    const result = await runEquaxisScript(root, "config-edit.mjs", args);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
