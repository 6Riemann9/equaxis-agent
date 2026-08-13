import { NextResponse } from "next/server";
import { readFileSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { findEquaxisRoot } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_TRACE_BYTES = 64 * 1024 * 1024;
const FAILURE_PATTERN = /failed|error|blocked|denied|rejected/i;

function isFailure(entry: Record<string, unknown>): boolean {
  return FAILURE_PATTERN.test(String(entry.event ?? "")) || entry.isError === true;
}

interface TraceEntry extends Record<string, unknown> {
  timestamp?: string;
  event?: string;
  sessionId?: string;
}

// GET /api/harness/events?cwd=&offset=&limit=&event=&session=&q=&failed=1
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim() ?? "";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") ?? "100") || 100));
  const eventFilter = url.searchParams.get("event")?.trim() ?? "";
  const sessionFilter = url.searchParams.get("session")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";
  const failedOnly = url.searchParams.get("failed") === "1";

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

  const tracePath = join(root, ".pi", "runtime", "traces.jsonl");
  let text: string;
  try {
    const stat = statSync(tracePath);
    if (stat.size > MAX_TRACE_BYTES) {
      return NextResponse.json({ error: `Trace file exceeds ${MAX_TRACE_BYTES / 1024 / 1024} MB; not readable through the web UI` }, { status: 413 });
    }
    text = readFileSync(tracePath, "utf8");
  } catch {
    return NextResponse.json({ error: "Trace file is missing or unreadable" }, { status: 404 });
  }

  const entries: TraceEntry[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line) as TraceEntry);
    } catch {
      // skip malformed trace lines
    }
  }

  const filtered = entries.filter((entry) => {
    if (failedOnly && !isFailure(entry)) return false;
    if (eventFilter && entry.event !== eventFilter) return false;
    if (sessionFilter && !String(entry.sessionId ?? "").includes(sessionFilter)) return false;
    if (query) {
      try {
        if (!JSON.stringify(entry).toLowerCase().includes(query.toLowerCase())) return false;
      } catch {
        return false;
      }
    }
    return true;
  });

  // Newest first (the file is chronological).
  const ordered = [...filtered].reverse();
  return NextResponse.json({
    total: ordered.length,
    offset,
    limit,
    events: ordered.slice(offset, offset + limit)
  });
}
