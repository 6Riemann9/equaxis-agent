import crypto from "node:crypto";

const stable = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());
const fingerprint = (schema) => crypto.createHash("sha256").update(stable(schema ?? {})).digest("hex").slice(0, 12);
const tokens = (value) => String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);

export class CrossProtocolToolRegistry {
  constructor(options = {}) {
    this.allowedProtocols = new Set(options.allowedProtocols ?? ["mcp", "cli", "http"]);
    this.sources = new Map();
    this.tools = new Map();
    this.listeners = new Set();
  }

  registerSource(source) {
    if (!source?.id || !source?.protocol || typeof source.discover !== "function" || typeof source.invoke !== "function") {
      throw new Error("source requires id, protocol, discover and invoke");
    }
    if (!this.allowedProtocols.has(source.protocol)) throw new Error(`protocol is not allowed: ${source.protocol}`);
    this.sources.set(source.id, { ...source, ttlMs: Math.max(1000, Number(source.ttlMs ?? 60000)) });
  }

  async refresh(sourceId) {
    const source = this.sources.get(sourceId);
    if (!source) throw new Error(`unknown source: ${sourceId}`);
    const discovered = await source.discover();
    const now = Date.now();
    const next = new Map();
    for (const tool of discovered) {
      if (!tool?.name || !tool?.description) continue;
      const id = `${source.protocol}:${source.id}:${tool.name}`;
      next.set(id, {
        id,
        sourceId: source.id,
        protocol: source.protocol,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
        schemaFingerprint: fingerprint(tool.inputSchema),
        risk: tool.risk ?? "medium",
        expiresAt: now + source.ttlMs,
        metadata: { ...(tool.metadata ?? {}) }
      });
    }
    for (const [id, tool] of this.tools) if (tool.sourceId === sourceId) this.tools.delete(id);
    for (const [id, tool] of next) this.tools.set(id, tool);
    this.listeners.forEach((listener) => listener({ sourceId, type: "refreshed", tools: this.snapshot(sourceId) }));
    return [...next.values()];
  }

  evictExpired(now = Date.now()) {
    const removed = [];
    for (const [id, tool] of this.tools) {
      if (tool.expiresAt <= now) { this.tools.delete(id); removed.push(id); }
    }
    if (removed.length) this.listeners.forEach((listener) => listener({ type: "evicted", removed }));
    return removed;
  }

  snapshot(sourceId) {
    return [...this.tools.values()].filter((tool) => !sourceId || tool.sourceId === sourceId);
  }

  subscribe(listener) {
    if (typeof listener !== "function") throw new Error("listener must be a function");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  search(query, options = {}) {
    this.evictExpired();
    const queryTokens = tokens(query);
    return [...this.tools.values()]
      .filter((tool) => !options.protocol || tool.protocol === options.protocol)
      .filter((tool) => !options.sourceId || tool.sourceId === options.sourceId)
      .map((tool) => {
        const haystack = tokens(`${tool.name} ${tool.description}`);
        const score = queryTokens.reduce((sum, token) => sum + (haystack.includes(token) ? 2 : haystack.some((part) => part.includes(token)) ? 1 : 0), 0);
        return { ...tool, score };
      })
      .filter((tool) => tool.score > 0 || queryTokens.length === 0)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, Math.max(1, Number(options.limit ?? 5)));
  }

  async invoke(toolId, args, context = {}) {
    this.evictExpired();
    const tool = this.tools.get(toolId);
    if (!tool) throw new Error(`tool is unavailable or expired: ${toolId}`);
    const source = this.sources.get(tool.sourceId);
    return source.invoke(tool.name, args, { ...context, toolId, schemaFingerprint: tool.schemaFingerprint });
  }
}
