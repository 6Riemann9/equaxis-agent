import { NextResponse } from "next/server";
import { readFileSync, statSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { findEquaxisRoot, getProjectSessionDir } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const MAX_FILE_BYTES = 32 * 1024 * 1024;
const MAX_LINES = 100_000;

// GET /api/harness/file?cwd=&path=&offset=&limit= -> raw lines of a runtime/session file
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim() ?? "";
  const filePath = url.searchParams.get("path")?.trim() ?? "";
  const offset = Math.max(0, Number(url.searchParams.get("offset") ?? "0") || 0);
  const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get("limit") ?? "200") || 200));

  if (!cwd || !isAbsolute(cwd)) {
    return NextResponse.json({ error: "cwd required" }, { status: 400 });
  }
  if (!filePath) {
    return NextResponse.json({ error: "path required" }, { status: 400 });
  }
  const root = findEquaxisRoot(cwd);
  if (!root) {
    return NextResponse.json({ error: "Not an Equaxis project (.pi/equaxis.json missing)" }, { status: 400 });
  }
  const allowedRoots = await getAllowedFileRoots();
  if (!isExistingFilePathAllowed(root, allowedRoots)) {
    return NextResponse.json({ error: "Access denied" }, { status: 403 });
  }

  // Constrain reads to the project's runtime dir, memory dir, or its session dir.
  const sessionDir = getProjectSessionDir(root);
  const candidate = isAbsolute(filePath) ? filePath : resolve(root, filePath);
  const insideRuntime = relative(join(root, ".pi", "runtime"), candidate).startsWith("..") === false;
  const insideMemory = relative(join(root, ".equaxis"), candidate).startsWith("..") === false;
  const insideSessions = relative(sessionDir, candidate).startsWith("..") === false;
  if (!insideRuntime && !insideMemory && !insideSessions) {
    return NextResponse.json({ error: "Path is outside the readable harness locations" }, { status: 403 });
  }

  let stat: Stats;
  try {
    stat = statSync(candidate);
  } catch {
    return NextResponse.json({ error: "File not found" }, { status: 404 });
  }
  if (!stat.isFile()) {
    return NextResponse.json({ error: "Not a file" }, { status: 400 });
  }
  if (stat.size > MAX_FILE_BYTES) {
    return NextResponse.json({ error: `File exceeds ${MAX_FILE_BYTES / 1024 / 1024} MB; not readable through the web UI` }, { status: 413 });
  }

  let text: string;
  try {
    text = readFileSync(candidate, "utf8");
  } catch (error) {
    return NextResponse.json({ error: `Unreadable file: ${String(error)}` }, { status: 500 });
  }
  const lines = text.split("\n");
  if (lines.length > MAX_LINES) {
    return NextResponse.json({ error: `File exceeds ${MAX_LINES} lines; not readable through the web UI` }, { status: 413 });
  }
  const page = lines.slice(offset, offset + limit).map((textLine, index) => ({ n: offset + index + 1, text: textLine }));
  return NextResponse.json({ path: filePath, totalLines: lines.length, offset, limit, lines: page });
}
