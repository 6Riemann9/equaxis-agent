import { NextResponse } from "next/server";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findEquaxisRoot } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_PENDING_AGE_MS = 10 * 60 * 1000;

function safeId(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

function readJson(filePath: string): Record<string, unknown> | null {
  try {
    return JSON.parse(readFileSync(filePath, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function listJson(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .map((name) => readJson(join(dir, name)))
    .filter((entry): entry is Record<string, unknown> => entry !== null);
}

function approvalsRoot(projectRoot: string): string {
  return join(projectRoot, ".pi", "runtime", "approvals");
}

// GET /api/harness/approvals?cwd=<root> -> pending requests + recent decisions
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

  const rootDir = approvalsRoot(root);
  const now = Date.now();
  const pending = listJson(join(rootDir, "requests"))
    .filter((request) => {
      const requestId = String(request.requestId ?? "");
      if (!requestId) return false;
      if (existsSync(join(rootDir, "decisions", `${safeId(requestId)}.json`))) return false;
      const requestedAt = new Date(String(request.requestedAt ?? "")).getTime();
      return Number.isFinite(requestedAt) && now - requestedAt <= MAX_PENDING_AGE_MS;
    })
    .sort((left, right) => String(left.requestedAt ?? "").localeCompare(String(right.requestedAt ?? "")));

  const history = listJson(join(rootDir, "decisions"))
    .filter((entry) => entry.decision === "approve" || entry.decision === "deny")
    .sort((left, right) => String(right.decidedAt ?? "").localeCompare(String(left.decidedAt ?? "")))
    .slice(0, 50);

  return NextResponse.json({ pending, history });
}

// POST /api/harness/approvals body: { cwd, requestId, decision: "approve" | "deny" }
export async function POST(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  if (!hasJsonContentType(request)) {
    return NextResponse.json({ error: "Content-Type must be application/json" }, { status: 415 });
  }
  try {
    const body = await request.json() as { cwd?: unknown; requestId?: unknown; decision?: unknown };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const requestId = typeof body.requestId === "string" ? body.requestId.trim() : "";
    const decision = body.decision;

    if (!cwd || !isAbsolute(cwd)) return NextResponse.json({ error: "cwd required" }, { status: 400 });
    if (!requestId) return NextResponse.json({ error: "requestId required" }, { status: 400 });
    if (decision !== "approve" && decision !== "deny") {
      return NextResponse.json({ error: "decision must be approve or deny" }, { status: 400 });
    }
    const root = findEquaxisRoot(cwd);
    if (!root) {
      return NextResponse.json({ error: "Not an Equaxis project (.pi/equaxis.json missing)" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(root, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    const rootDir = approvalsRoot(root);
    mkdirSync(join(rootDir, "decisions"), { recursive: true });
    writeFileSync(
      join(rootDir, "decisions", `${safeId(requestId)}.json`),
      JSON.stringify({ requestId, decision, decidedAt: new Date().toISOString() }, null, 2),
      "utf8",
    );
    return NextResponse.json({ ok: true, requestId, decision });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
