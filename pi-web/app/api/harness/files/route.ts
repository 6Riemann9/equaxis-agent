import { NextResponse } from "next/server";
import { existsSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { findEquaxisRoot, getProjectSessionDir } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const RUNTIME_RELATIVES = [
  ".pi/runtime/traces.jsonl",
  ".pi/runtime/release-manifest.json",
  ".pi/runtime/protocols/traces.jsonl",
  ".pi/runtime/eval-loop/events.jsonl",
  ".pi/runtime/subagents/events.jsonl",
  ".pi/runtime/memory-governance/memories.jsonl",
  ".pi/runtime/artifacts",
  ".pi/runtime/isolated",
  ".equaxis/memory/history/history.jsonl"
];

interface FileEntry {
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  kind: "runtime" | "session";
}

function entryFor(projectRoot: string, relativePath: string, kind: "runtime" | "session"): FileEntry {
  const absolute = join(projectRoot, relativePath);
  const base = { path: relativePath, exists: false, bytes: 0, modifiedAt: null as string | null, kind };
  if (!existsSync(absolute)) return base;
  try {
    const stat = statSync(absolute);
    return { ...base, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString() };
  } catch {
    return base;
  }
}

// NOTE: use fs.promises.readdir (not readdirSync) — on some Windows systems
// readdirSync silently returns [] for directories under the user profile,
// while the async API lists them correctly.
async function listDir(projectRoot: string, relativePath: string, kind: "runtime" | "session", maxDepth: number): Promise<FileEntry[]> {
  const absolute = join(projectRoot, relativePath);
  if (!existsSync(absolute)) return [];
  const results: FileEntry[] = [];
  const walk = async (dir: string, relPrefix: string, depth: number) => {
    if (depth > maxDepth) return;
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(dir, name);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      const rel = `${relPrefix}/${name}`;
      if (stat.isDirectory()) {
        await walk(full, rel, depth + 1);
      } else {
        results.push({ path: rel, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), kind });
      }
    }
  };
  await walk(absolute, relativePath, 0);
  return results;
}

// GET /api/harness/files?cwd=<root> -> runtime artifacts + recent session files
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

  const files: FileEntry[] = [];
  for (const relative of RUNTIME_RELATIVES) {
    if (relative.endsWith("/artifacts") || relative.endsWith("/isolated")) {
      files.push(...(await listDir(root, relative, "runtime", 4)));
    } else {
      files.push(entryFor(root, relative, "runtime"));
    }
  }

  const sessionDir = getProjectSessionDir(root);
  const sessionFiles: FileEntry[] = [];
  if (existsSync(sessionDir)) {
    let names: string[];
    try {
      names = await readdir(sessionDir);
    } catch {
      names = [];
    }
    const sorted = names
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => ({ name, stat: statSync(join(sessionDir, name)) }))
      .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      .slice(0, 30);
    for (const { name, stat } of sorted) {
      sessionFiles.push({ path: name, exists: true, bytes: stat.size, modifiedAt: stat.mtime.toISOString(), kind: "session" });
    }
  }

  return NextResponse.json({ files, sessionFiles });
}
