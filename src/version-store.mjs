import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function assertInside(root, target, label) {
  const relative = path.relative(root, target);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`${label} must stay inside the workspace: ${relative}`);
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function safeName(value) {
  return String(value || "candidate").replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "candidate";
}

export class VersionStore {
  constructor(options = {}) {
    this.projectRoot = path.resolve(options.projectRoot ?? process.cwd());
    this.rootDir = path.resolve(this.projectRoot, options.rootDir ?? ".pi/runtime/versions");
    assertInside(this.projectRoot, this.rootDir, "version store path");
  }

  pathFor(kind, id) {
    return path.join(this.rootDir, safeName(kind), `${safeName(id)}.json`);
  }

  read(kind, id) {
    const filePath = this.pathFor(kind, id);
    if (!fs.existsSync(filePath)) throw new Error(`version artifact not found: ${kind}/${id}`);
    return { ...JSON.parse(fs.readFileSync(filePath, "utf8")), path: filePath };
  }

  writeArtifact(artifact) {
    const filePath = this.pathFor(artifact.kind, artifact.id);
    const stored = { ...artifact };
    stored.sha = hash({ ...stored, sha: undefined });
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(stored, null, 2)}\n`, "utf8");
    return { ...stored, path: filePath };
  }

  updateStatus(kind, id, status, updates = {}) {
    const current = this.read(kind, id);
    return this.writeArtifact({
      ...current,
      path: undefined,
      status,
      updatedAt: updates.updatedAt ?? new Date().toISOString(),
      decision: updates.decision ?? current.decision,
      metadata: { ...(current.metadata ?? {}), ...(updates.metadata ?? {}) }
    });
  }

  writeCandidate(input = {}) {
    const kind = input.kind ?? "candidate";
    const id = input.id ?? `${kind}-${new Date().toISOString().replaceAll(":", "-")}`;
    const artifact = {
      kind,
      id,
      version: input.version ?? { kind, id, sha: null },
      status: input.status ?? "candidate",
      createdAt: input.createdAt ?? new Date().toISOString(),
      provenance: input.provenance ?? {},
      changes: input.changes ?? [],
      decision: input.decision ?? null,
      metadata: input.metadata ?? {}
    };
    return this.writeArtifact(artifact);
  }

  list(kind = null) {
    if (!fs.existsSync(this.rootDir)) return [];
    const kinds = kind ? [safeName(kind)] : fs.readdirSync(this.rootDir).filter((entry) => fs.statSync(path.join(this.rootDir, entry)).isDirectory());
    const artifacts = [];
    for (const itemKind of kinds) {
      const dir = path.join(this.rootDir, itemKind);
      if (!fs.existsSync(dir)) continue;
      for (const file of fs.readdirSync(dir).filter((entry) => entry.endsWith(".json"))) {
        const artifact = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
        artifacts.push({ ...artifact, path: path.join(dir, file) });
      }
    }
    return artifacts.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || String(a.id).localeCompare(String(b.id)));
  }
}
