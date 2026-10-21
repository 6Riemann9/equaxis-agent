import { NextResponse } from "next/server";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { findEquaxisRoot, findEquaxisRuntime } from "@/lib/equaxis-project";
import { getAllowedFileRoots, isExistingFilePathAllowed } from "@/lib/file-access";
import { hasJsonContentType, isApiRequestAllowed } from "@/lib/request-security";

export const dynamic = "force-dynamic";

const RESPONSE_PREFIX = "__EQUAXIS_MEMORY__";
const BRIDGE_TIMEOUT_MS = 30_000;
const SNAPSHOT_CACHE_TTL_MS = 3_000;
const MAX_PAGE_LIMIT = 500;

// Short-TTL snapshot cache: the bridge spawns a fresh process per request, so
// rapid dashboard refreshes would otherwise pay process + store load each
// time. Mutations (POST) invalidate every cached entry for their root.
interface CacheEntry { expiresAt: number; value: unknown }
const snapshotCache = new Map<string, CacheEntry>();

function cachedSnapshot(key: string): unknown | undefined {
  const entry = snapshotCache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt <= Date.now()) {
    snapshotCache.delete(key);
    return undefined;
  }
  return entry.value;
}

function storeSnapshot(key: string, value: unknown): void {
  if (snapshotCache.size > 64) {
    const oldest = snapshotCache.keys().next().value;
    if (oldest !== undefined) snapshotCache.delete(oldest);
  }
  snapshotCache.set(key, { expiresAt: Date.now() + SNAPSHOT_CACHE_TTL_MS, value });
}

function invalidateSnapshotsForRoot(root: string): void {
  for (const key of snapshotCache.keys()) {
    if (key.startsWith(`${root}|`)) snapshotCache.delete(key);
  }
}

function parsePageParam(raw: string | null, fallback: number, max: number): number {
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.min(Math.floor(parsed), max);
}

interface MemoryConfig {
  backend?: string;
  pythonCommand?: string;
  rootDir?: string;
}

function readMemoryConfig(root: string): MemoryConfig {
  try {
    const raw = JSON.parse(readFileSync(join(root, ".pi", "equaxis.json"), "utf8")) as {
      memory?: MemoryConfig;
    };
    return raw.memory ?? {};
  } catch {
    return {};
  }
}

function requestBridge(
  projectRoot: string,
  action: string,
  payload: Record<string, unknown>,
): Promise<unknown> {
  const config = readMemoryConfig(projectRoot);
  const rootDir = resolve(projectRoot, config.rootDir ?? ".equaxis/memory");
  // The runtime (scripts/, bridge/) lives in the installed package, which for
  // global installs is NOT the project root — resolve it separately.
  const runtimeRoot = findEquaxisRuntime(projectRoot);
  if (!runtimeRoot) {
    return Promise.reject(new Error("Equaxis runtime not found (scripts/memory-json.mjs) — set EQUAXIS_RUNTIME_HOME or run from an Equaxis package"));
  }
  // memory.backend selects the process: native (Node core) or python (legacy bridge).
  const native = config.backend !== "python";
  const command = native ? process.execPath : (config.pythonCommand ?? "python");
  const args = native
    ? [join(runtimeRoot, "scripts", "memory-json.mjs"), "--root", rootDir]
    : ["-u", join(runtimeRoot, "bridge", "memory_bridge.py"), "--root", rootDir];

  const { promise, resolve: settleResolve, reject: settleReject } = Promise.withResolvers<unknown>();
  const child = spawn(command, args, {
    cwd: runtimeRoot,
    env: {
      ...process.env,
      PYTHONIOENCODING: "utf-8",
      PYTHONUTF8: "1",
    },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let settled = false;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    child.kill();
    settleReject(new Error("Memory bridge timed out"));
  }, BRIDGE_TIMEOUT_MS);

  const settle = (fn: () => void) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    fn();
  };

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  child.once("error", (error) => {
    settle(() => settleReject(error));
  });
  child.once("exit", () => {
    settle(() => {
      let response: { ok: boolean; result?: unknown; error?: { message?: string } } | undefined;
      for (const line of stdout.split("\n")) {
        if (!line.startsWith(RESPONSE_PREFIX)) continue;
        try {
          response = JSON.parse(line.slice(RESPONSE_PREFIX.length)) as typeof response;
        } catch {
          continue;
        }
        if (response) break;
      }
      if (!response) {
        settleReject(new Error(stderr.trim() || "No memory bridge response"));
        return;
      }
      if (response.ok) {
        settleResolve(response.result);
      } else {
        settleReject(new Error(response.error?.message ?? "Memory request failed"));
      }
    });
  });

  child.stdin.write(`${JSON.stringify({ id: "web", action, payload })}\n`, (error) => {
    if (error) child.kill();
  });
  child.stdin.end();
  return promise;
}

// GET /api/memory?cwd=<root>            -> visualization snapshot
// GET /api/memory?cwd=<root>&q=<query>  -> semantic search
export async function GET(request: Request) {
  if (!isApiRequestAllowed(request)) {
    return NextResponse.json({ error: "Untrusted API request" }, { status: 403 });
  }
  const url = new URL(request.url);
  const cwd = url.searchParams.get("cwd")?.trim() ?? "";
  const query = url.searchParams.get("q")?.trim() ?? "";

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
    if (query) {
      const result = await requestBridge(root, "search", { query, limit: 20 }) as { matches?: unknown[] };
      return NextResponse.json({ matches: result.matches ?? [] });
    }
    // CRUD audit trail: /api/memory?cwd=<root>&audit=<limit>[&auditOffset=<n>]
    const auditParam = url.searchParams.get("audit");
    if (auditParam !== null) {
      const auditLimit = parsePageParam(auditParam, 50, MAX_PAGE_LIMIT);
      const auditOffset = parsePageParam(url.searchParams.get("auditOffset"), 0, Number.MAX_SAFE_INTEGER);
      const auditLog = await requestBridge(root, "audit_log", { limit: auditLimit || 50, offset: auditOffset });
      return NextResponse.json(auditLog);
    }
    const limit = parsePageParam(url.searchParams.get("limit"), MAX_PAGE_LIMIT, MAX_PAGE_LIMIT);
    const offset = parsePageParam(url.searchParams.get("offset"), 0, Number.MAX_SAFE_INTEGER);
    const cacheKey = `${root}|visualize|${limit}|${offset}`;
    const cached = cachedSnapshot(cacheKey);
    if (cached !== undefined) {
      return NextResponse.json(cached, { headers: { "x-equaxis-cache": "hit" } });
    }
    const snapshot = await requestBridge(root, "visualize", { limit, offset });
    storeSnapshot(cacheKey, snapshot);
    return NextResponse.json(snapshot, { headers: { "x-equaxis-cache": "miss" } });
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}

// POST /api/memory body: { cwd, action: "update" | "delete" | "remember", ... }
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
      drawer_id?: unknown;
      content?: unknown;
      wing?: unknown;
      room?: unknown;
      hall?: unknown;
      source_file?: unknown;
      metadata?: unknown;
    };
    const cwd = typeof body.cwd === "string" ? body.cwd.trim() : "";
    const action = typeof body.action === "string" ? body.action : "";

    if (!cwd || !isAbsolute(cwd)) {
      return NextResponse.json({ error: "cwd required" }, { status: 400 });
    }
    if (action !== "update" && action !== "delete" && action !== "remember") {
      return NextResponse.json({ error: "action must be update, delete or remember" }, { status: 400 });
    }

    const root = findEquaxisRoot(cwd);
    if (!root) {
      return NextResponse.json({ error: "Not an Equaxis project (.pi/equaxis.json missing)" }, { status: 400 });
    }
    const allowedRoots = await getAllowedFileRoots();
    if (!isExistingFilePathAllowed(root, allowedRoots)) {
      return NextResponse.json({ error: "Access denied" }, { status: 403 });
    }

    if (action === "delete") {
      const drawerId = typeof body.drawer_id === "string" ? body.drawer_id.trim() : "";
      if (!drawerId) {
        return NextResponse.json({ error: "drawer_id required" }, { status: 400 });
      }
      const result = await requestBridge(root, "delete_memory", { drawer_id: drawerId });
      invalidateSnapshotsForRoot(root);
      return NextResponse.json(result);
    }

    if (action === "update") {
      const drawerId = typeof body.drawer_id === "string" ? body.drawer_id.trim() : "";
      if (!drawerId) {
        return NextResponse.json({ error: "drawer_id required" }, { status: 400 });
      }
      const result = await requestBridge(root, "update_memory", {
        drawer_id: drawerId,
        content: typeof body.content === "string" ? body.content : undefined,
        wing: typeof body.wing === "string" ? body.wing : undefined,
        room: typeof body.room === "string" ? body.room : undefined,
        hall: typeof body.hall === "string" ? body.hall : undefined,
        source_file: typeof body.source_file === "string" ? body.source_file : undefined,
      });
      invalidateSnapshotsForRoot(root);
      return NextResponse.json(result);
    }

    const content = typeof body.content === "string" ? body.content.trim() : "";
    const wing = typeof body.wing === "string" ? body.wing.trim() : "";
    const room = typeof body.room === "string" ? body.room.trim() : "";
    if (!content) {
      return NextResponse.json({ error: "content required" }, { status: 400 });
    }
    if (!wing || !room) {
      return NextResponse.json({ error: "wing and room required" }, { status: 400 });
    }
    const result = await requestBridge(root, "remember", {
      content,
      wing,
      room,
      hall: typeof body.hall === "string" ? body.hall : "hall_general",
      source_file: typeof body.source_file === "string" ? body.source_file : "pi-web",
      metadata: body.metadata ?? { source: "pi-web" },
    });
    invalidateSnapshotsForRoot(root);
    return NextResponse.json(result);
  } catch (error) {
    return NextResponse.json({ error: String(error) }, { status: 500 });
  }
}
