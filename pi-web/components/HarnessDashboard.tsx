"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

interface ReliabilityState {
  mode: string;
  phase: string;
  turnCount: number;
  toolCalls: number;
  blockedCalls: number;
  approvedCalls: number;
  failedCalls: number;
  lastRisk: string;
}

interface Snapshot {
  generatedAt: string;
  projectRoot: string;
  doctor: { ok: boolean; checks: Array<{ name: string; status: boolean; detail?: string }> } | null;
  dashboard: {
    health: { ok: boolean; failing: string[]; checks: number };
    reliability: { mode: string; traceDir: string; approvals: { highRiskBash: boolean; externalEditPolicy: string } } | null;
    gates: { ok: boolean; enabled: boolean; failing: string[]; checks: number };
    subagents: { enabled: boolean; maxConcurrent: number; persistence: boolean; isolation: boolean } | null;
    memory: { enabled: boolean; rootDir: string; autoRecall: boolean } | null;
    evaluation: { enabled: boolean; attempts: number; successRate: number | null; candidates: number } | null;
    memoryGovernance: { enabled: boolean; auditLog: { exists: boolean; bytes: number } } | null;
    protocols: { lsp: { status: string }; dap: { status: string } } | null;
    runtimeFiles: { protocolTrace: { exists: boolean; bytes: number }; subagentEvents: { exists: boolean; bytes: number } };
  } | null;
  reliability: { sessionFile: string; state: ReliabilityState } | null;
  eval: EvalStats | { error: string } | null;
  harbor: HarborData | { error: string } | null;
  traces: {
    total: number;
    byEvent: Record<string, number>;
    failureEvents: number;
    recentEvents: Array<{
      timestamp: string;
      event: string;
      phase: string | null;
      toolName: string | null;
      risk: string | null;
      chars: number | null;
      error: string | null;
      detail: unknown;
    }>;
  };
}

interface TraceEvent {
  timestamp?: string;
  event?: string;
  sessionId?: string;
  phase?: string | null;
  toolName?: string | null;
  risk?: string | null;
  error?: string | null;
  [key: string]: unknown;
}

interface FileEntry {
  path: string;
  exists: boolean;
  bytes: number;
  modifiedAt: string | null;
  kind: "runtime" | "session";
}

interface FileContent {
  path: string;
  totalLines: number;
  offset: number;
  limit: number;
  lines: Array<{ n: number; text: string }>;
}

interface EvalStats {
  attempts: number;
  successes: number;
  failures: number;
  unknowns: number;
  successRate: number | null;
  decisions: unknown[];
  matrix: EvalMatrixRow[];
}

interface HarborData {
  budget: {
    equaxis?: Record<string, unknown>;
    pi_control?: Record<string, unknown>;
    gain?: Record<string, unknown>;
  } | null;
  cycle: {
    cycleDir?: string;
    cycleId?: string;
    generatedAt?: string;
    diagnosis?: Record<string, unknown>;
    hypotheses?: unknown[];
    experiments?: unknown[];
    decisions?: unknown[];
    nextIterationFocus?: unknown[];
  } | null;
}

const RISK_COLORS: Record<string, string> = { low: "#16a34a", medium: "#f59e0b", high: "#dc2626" };
const PAGE_SIZE = 100;
const FILE_PAGE_SIZE = 200;

interface EvalMatrixRow {
  provider: string;
  model: string;
  tool: string;
  capabilities: string[];
  attempts: number;
  successes: number;
  failures: number;
  unknowns: number;
  successRate: number | null;
  averageLatencyMs: number | null;
  averageInputTokens: number | null;
  averageOutputTokens: number | null;
  averageCostUsd: number | null;
  errorCodes: Record<string, number>;
}

const EVAL_COLUMNS: Array<{ key: string; label: string; value: (row: EvalMatrixRow) => number | string | null }> = [
  { key: "model", label: "Provider / Model", value: (row) => `${row.provider}/${row.model}` },
  { key: "tool", label: "Tool", value: (row) => row.tool },
  { key: "caps", label: "Capabilities", value: (row) => row.capabilities.join(", ") },
  { key: "attempts", label: "Attempts", value: (row) => row.attempts },
  { key: "rate", label: "Rate", value: (row) => row.successRate },
  { key: "fail", label: "Fail", value: (row) => row.failures },
  { key: "latency", label: "Latency", value: (row) => row.averageLatencyMs },
  { key: "tokens", label: "In/Out tokens", value: (row) => row.averageInputTokens },
  { key: "cost", label: "Cost", value: (row) => row.averageCostUsd },
  { key: "errors", label: "Errors", value: (row) => Object.keys(row.errorCodes).length }
];

function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatTime(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleTimeString();
}

function formatDate(timestamp: string): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return timestamp;
  return date.toLocaleString();
}

function shortDetail(entry: TraceEvent): string | null {
  const candidates = [entry.error, entry.reason, entry.toolName];
  for (const value of candidates) {
    if (typeof value === "string" && value) return value;
  }
  return null;
}

type Tab = "overview" | "events" | "files" | "eval" | "harbor";

export function HarnessDashboard({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("overview");

  // Events view
  const [events, setEvents] = useState<{ total: number; offset: number; limit: number; events: TraceEvent[] } | null>(null);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventFilter, setEventFilter] = useState("");
  const [sessionFilter, setSessionFilter] = useState("");
  const [query, setQuery] = useState("");
  const [failedOnly, setFailedOnly] = useState(false);
  const [offset, setOffset] = useState(0);
  const [expandedEvent, setExpandedEvent] = useState<number | null>(null);

  // Files view
  const [files, setFiles] = useState<{ files: FileEntry[]; sessionFiles: FileEntry[] } | null>(null);
  const [openFile, setOpenFile] = useState<FileEntry | null>(null);
  const [fileContent, setFileContent] = useState<FileContent | null>(null);
  const [fileOffset, setFileOffset] = useState(0);
  const [evalSort, setEvalSort] = useState<{ key: string; dir: "asc" | "desc" }>({ key: "", dir: "asc" });

  const load = useCallback(() => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    fetch(`/api/harness?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
        setSnapshot(body as Snapshot);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setLoading(false));
  }, [cwd]);

  useEffect(() => { load(); }, [cwd, load]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const loadEvents = useCallback((nextOffset: number, overrides?: { failed?: boolean }) => {
    if (!cwd) return;
    const failed = overrides?.failed ?? failedOnly;
    setEventsLoading(true);
    setError(null);
    const params = new URLSearchParams({ cwd, offset: String(nextOffset), limit: String(PAGE_SIZE) });
    if (eventFilter) params.set("event", eventFilter);
    if (sessionFilter) params.set("session", sessionFilter);
    if (query) params.set("q", query);
    if (failed) params.set("failed", "1");
    fetch(`/api/harness/events?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
        setEvents(body as { total: number; offset: number; limit: number; events: TraceEvent[] });
        setOffset(nextOffset);
        setExpandedEvent(null);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)))
      .finally(() => setEventsLoading(false));
  }, [cwd, eventFilter, sessionFilter, query, failedOnly]);

  const loadFiles = useCallback(() => {
    if (!cwd) return;
    setError(null);
    fetch(`/api/harness/files?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
        setFiles(body as { files: FileEntry[]; sessionFiles: FileEntry[] });
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [cwd]);

  const loadFileContent = useCallback((entry: FileEntry, nextOffset: number) => {
    if (!cwd) return;
    setError(null);
    const params = new URLSearchParams({ cwd, path: entry.path, offset: String(nextOffset), limit: String(FILE_PAGE_SIZE) });
    fetch(`/api/harness/file?${params.toString()}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
        setFileContent(body as FileContent);
        setFileOffset(nextOffset);
      })
      .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason)));
  }, [cwd]);

  const openTab = useCallback((next: Tab) => {
    setTab(next);
    setError(null);
    if (next === "events" && !events) loadEvents(0);
    if (next === "files" && !files) loadFiles();
  }, [events, files, loadEvents, loadFiles]);

  const reliability = snapshot?.reliability?.state ?? null;
  const dashboard = snapshot?.dashboard ?? null;
  const doctor = snapshot?.doctor ?? null;
  const traces = snapshot?.traces ?? null;
  const evalData = snapshot?.eval && !("error" in snapshot.eval) ? snapshot.eval : null;
  const harborData = snapshot?.harbor && !("error" in snapshot.harbor) ? snapshot.harbor : null;

  const sortedMatrix = useMemo(() => {
    const matrix = evalData?.matrix ?? [];
    if (!evalSort.key) return matrix;
    const column = EVAL_COLUMNS.find((item) => item.key === evalSort.key);
    if (!column) return matrix;
    const dir = evalSort.dir === "asc" ? 1 : -1;
    return [...matrix].sort((left, right) => {
      const leftValue = column.value(left);
      const rightValue = column.value(right);
      if (leftValue == null && rightValue == null) return 0;
      if (leftValue == null) return 1;
      if (rightValue == null) return -1;
      if (typeof leftValue === "number" && typeof rightValue === "number") return (leftValue - rightValue) * dir;
      return String(leftValue).localeCompare(String(rightValue)) * dir;
    });
  }, [evalData, evalSort]);

  const toggleEvalSort = useCallback((key: string) => {
    setEvalSort((current) => {
      if (current.key === key) return { key, dir: current.dir === "asc" ? "desc" : "asc" };
      return { key, dir: "asc" };
    });
  }, []);
  const healthChecks = doctor?.checks ?? [];
  const passing = healthChecks.filter((check) => check.status).length;

  return (
    <div className="harness-backdrop" role="dialog" aria-modal="true" aria-label="Equaxis harness">
      <div className="harness-panel">
        <header className="harness-header">
          <div>
            <div className="harness-kicker">EQUAXIS HARNESS</div>
            <h1>Runtime harness</h1>
            <p>{cwd ?? "No workspace selected"}</p>
          </div>
          <div className="harness-header-actions">
            <button className="harness-icon-button" onClick={() => { load(); if (tab === "events") loadEvents(0); if (tab === "files") loadFiles(); }} disabled={loading} title="Refresh harness">{loading ? "..." : "↻"}</button>
            <button className="harness-icon-button" onClick={onClose} title="Close harness">×</button>
          </div>
        </header>

        <div className="harness-tabs">
          <button className={tab === "overview" ? "active" : ""} onClick={() => openTab("overview")}>Overview</button>
          <button className={tab === "events" ? "active" : ""} onClick={() => openTab("events")}>
            Events{traces && traces.total > 0 ? ` (${traces.total})` : ""}
          </button>
          <button className={tab === "files" ? "active" : ""} onClick={() => openTab("files")}>Files</button>
          <button className={tab === "eval" ? "active" : ""} onClick={() => openTab("eval")}>Eval</button>
          <button className={tab === "harbor" ? "active" : ""} onClick={() => openTab("harbor")}>Harbor</button>
          {traces && traces.failureEvents > 0 && (
            <button className={`harness-failures-tab${failedOnly && tab === "events" ? " active" : ""}`} onClick={() => { setTab("events"); setFailedOnly(true); setOffset(0); loadEvents(0, { failed: true }); }}>
              Failures ({traces.failureEvents})
            </button>
          )}
        </div>

        <div className="harness-body">
          {error && <div className="harness-error">{error}<button onClick={() => { if (tab === "events") loadEvents(0); else if (tab === "files") loadFiles(); else load(); }}>Retry</button></div>}
          {tab === "overview" && (
            !snapshot ? <div className="harness-empty">{loading ? "Loading harness..." : "Select an Equaxis workspace to inspect the harness."}</div> : <>
              {reliability && (
                <section className="harness-live">
                  <div className="harness-section-title">Reliability harness</div>
                  <div className="harness-metrics">
                    <div><span>Mode</span><strong className={reliability.mode === "enforce" ? "harness-enforce" : ""}>{reliability.mode}</strong></div>
                    <div><span>Phase</span><strong>{reliability.phase}</strong></div>
                    <div><span>Last risk</span><strong style={{ color: RISK_COLORS[reliability.lastRisk] ?? "var(--text)" }}>{reliability.lastRisk}</strong></div>
                    <div><span>Turn count</span><strong>{reliability.turnCount}</strong></div>
                    <div><span>Tool calls</span><strong>{reliability.toolCalls}</strong></div>
                    <div><span>Approved</span><strong>{reliability.approvedCalls}</strong></div>
                    <div><span>Blocked</span><strong className={reliability.blockedCalls > 0 ? "harness-blocked" : ""}>{reliability.blockedCalls}</strong></div>
                    <div><span>Failed</span><strong className={reliability.failedCalls > 0 ? "harness-failed" : ""}>{reliability.failedCalls}</strong></div>
                  </div>
                </section>
              )}

              <section className="harness-section">
                <div className="harness-section-title">
                  Health · {passing}/{healthChecks.length} checks
                  {dashboard?.gates && <span className={dashboard.gates.ok ? "harness-ok-tag" : "harness-bad-tag"}>
                    gates {dashboard.gates.ok ? "READY" : "FAIL"}
                  </span>}
                  {traces && traces.failureEvents > 0 && (
                    <button className="harness-failure-link" onClick={() => { setTab("events"); setFailedOnly(true); setOffset(0); loadEvents(0, { failed: true }); }}>
                      {traces.failureEvents} failure events →
                    </button>
                  )}
                </div>
                <div className="harness-checks">
                  {healthChecks.map((check) => (
                    <div key={check.name} className={check.status ? "harness-check ok" : "harness-check bad"}>
                      <span className="harness-check-mark">{check.status ? "✓" : "✗"}</span>
                      <span className="harness-check-name">{check.name}</span>
                      {check.detail && <code className="harness-check-detail">{check.detail}</code>}
                    </div>
                  ))}
                </div>
              </section>

              <section className="harness-section">
                <div className="harness-section-title">Configuration</div>
                <div className="harness-config-grid">
                  {dashboard?.reliability && (
                    <div className="harness-config-card">
                      <b>Reliability</b>
                      <span>mode: {dashboard.reliability.mode}</span>
                      <span>high-risk bash approval: {dashboard.reliability.approvals.highRiskBash ? "on" : "off"}</span>
                      <span>external edits: {dashboard.reliability.approvals.externalEditPolicy}</span>
                      <code>{dashboard.reliability.traceDir}</code>
                    </div>
                  )}
                  {dashboard?.subagents && (
                    <div className="harness-config-card">
                      <b>Subagents</b>
                      <span>{dashboard.subagents.enabled ? "enabled" : "disabled"} · max {dashboard.subagents.maxConcurrent}</span>
                      <span>persistence {dashboard.subagents.persistence ? "on" : "off"} · isolation {dashboard.subagents.isolation ? "on" : "off"}</span>
                    </div>
                  )}
                  {dashboard?.memory && (
                    <div className="harness-config-card">
                      <b>Memory</b>
                      <span>{dashboard.memory.enabled ? "enabled" : "disabled"} · autoRecall {dashboard.memory.autoRecall ? "on" : "off"}</span>
                      <code>{dashboard.memory.rootDir}</code>
                    </div>
                  )}
                  {dashboard?.evaluation && (
                    <div className="harness-config-card">
                      <b>Evaluation</b>
                      <span>{dashboard.evaluation.enabled ? "enabled" : "disabled"} · {dashboard.evaluation.attempts} attempts</span>
                      <span>success rate: {dashboard.evaluation.successRate != null ? `${(dashboard.evaluation.successRate * 100).toFixed(1)}%` : "n/a"}</span>
                      <span>{dashboard.evaluation.candidates} candidates</span>
                    </div>
                  )}
                  {dashboard?.memoryGovernance && (
                    <div className="harness-config-card">
                      <b>Memory governance</b>
                      <span>{dashboard.memoryGovernance.enabled ? "enabled" : "disabled"} · audit {dashboard.memoryGovernance.auditLog.exists ? formatBytes(dashboard.memoryGovernance.auditLog.bytes) : "missing"}</span>
                    </div>
                  )}
                  {dashboard?.protocols && (
                    <div className="harness-config-card">
                      <b>Protocols</b>
                      <span>LSP {dashboard.protocols.lsp.status} · DAP {dashboard.protocols.dap.status}</span>
                    </div>
                  )}
                  {dashboard?.runtimeFiles && (
                    <div className="harness-config-card">
                      <b>Runtime files</b>
                      <span>protocol trace {dashboard.runtimeFiles.protocolTrace.exists ? formatBytes(dashboard.runtimeFiles.protocolTrace.bytes) : "missing"}</span>
                      <span>subagent events {dashboard.runtimeFiles.subagentEvents.exists ? formatBytes(dashboard.runtimeFiles.subagentEvents.bytes) : "missing"}</span>
                    </div>
                  )}
                </div>
              </section>
            </>
          )}

          {tab === "events" && (
            <section className="harness-section">
              <div className="harness-events-toolbar">
                <select value={eventFilter} onChange={(event) => { setEventFilter(event.target.value); setOffset(0); }} title="Filter by event type">
                  <option value="">all event types</option>
                  {Object.keys(traces?.byEvent ?? {}).sort().map((name) => (
                    <option key={name} value={name}>{name}</option>
                  ))}
                </select>
                <input value={sessionFilter} onChange={(event) => { setSessionFilter(event.target.value); setOffset(0); }} placeholder="session id…" />
                <input value={query} onChange={(event) => { setQuery(event.target.value); setOffset(0); }} placeholder="search text…" onKeyDown={(event) => { if (event.key === "Enter") loadEvents(0); }} />
                <button className={`harness-failure-toggle${failedOnly ? " active" : ""}`} onClick={() => { const next = !failedOnly; setFailedOnly(next); setOffset(0); loadEvents(0, { failed: next }); }}>
                  failures only
                </button>
                <button className="harness-action-btn" onClick={() => loadEvents(offset)} disabled={eventsLoading}>{eventsLoading ? "Loading…" : "Apply"}</button>
              </div>
              {events && (
                <>
                  <div className="harness-pagination">
                    <span>{events.total === 0 ? "no matching events" : `${events.offset + 1}–${Math.min(events.offset + events.events.length, events.total)} of ${events.total}`}</span>
                    <button className="harness-action-btn" disabled={events.offset === 0 || eventsLoading} onClick={() => loadEvents(Math.max(0, events.offset - PAGE_SIZE))}>← Prev</button>
                    <button className="harness-action-btn" disabled={events.offset + events.events.length >= events.total || eventsLoading} onClick={() => loadEvents(events.offset + PAGE_SIZE)}>Next →</button>
                  </div>
                  <div className="harness-event-list">
                    {events.events.map((entry, index) => {
                      const detail = shortDetail(entry);
                      const isExpanded = expandedEvent === index;
                      return (
                        <div key={index} className={`harness-event-row clickable${/failed|error|blocked|denied/.test(String(entry.event)) ? " failed" : ""}`} onClick={() => setExpandedEvent(isExpanded ? null : index)}>
                          <code className="harness-event-time">{formatTime(entry.timestamp ?? "")}</code>
                          <span className="harness-event-name">{entry.event ?? "?"}</span>
                          {entry.phase && <em>{String(entry.phase)}</em>}
                          {entry.toolName && <code className="harness-event-tool">{String(entry.toolName)}</code>}
                          {entry.risk && <span className="harness-event-risk">{String(entry.risk)}</span>}
                          {entry.sessionId && <span className="harness-event-session">{String(entry.sessionId).slice(0, 12)}…</span>}
                          {detail && <span className="harness-event-error" title={detail}>{detail.slice(0, 90)}</span>}
                          {isExpanded && (
                            <pre className="harness-event-raw">{JSON.stringify(entry, null, 2)}</pre>
                          )}
                        </div>
                      );
                    })}
                    {events.events.length === 0 && <div className="harness-empty">No events match the current filters.</div>}
                  </div>
                </>
              )}
            </section>
          )}

          {tab === "eval" && (
            <section className="harness-section">
              {!evalData ? (
                <div className="harness-empty">No eval data yet. Run sessions or `node scripts/equaxis.mjs eval record …`.</div>
              ) : (
                <>
                  <div className="harness-section-title">Eval outcomes (traces-derived)</div>
                  <div className="harness-metrics harness-metrics-5">
                    <div><span>Attempts</span><strong>{evalData.attempts}</strong></div>
                    <div><span>Successes</span><strong>{evalData.successes}</strong></div>
                    <div><span>Failures</span><strong className={evalData.failures > 0 ? "harness-failed" : ""}>{evalData.failures}</strong></div>
                    <div><span>Unknowns</span><strong>{evalData.unknowns}</strong></div>
                    <div><span>Success rate</span><strong>{evalData.successRate != null ? `${(evalData.successRate * 100).toFixed(1)}%` : "n/a"}</strong></div>
                  </div>
                  <div className="harness-eval-table-wrap">
                    <table className="harness-eval-table">
                      <thead>
                        <tr>
                          {EVAL_COLUMNS.map((column) => (
                            <th key={column.key} className="harness-eval-sortable" onClick={() => toggleEvalSort(column.key)} title={`Sort by ${column.label}`}>
                              {column.label}
                              {evalSort.key === column.key && <span className="harness-eval-sort-ind">{evalSort.dir === "asc" ? " ▲" : " ▼"}</span>}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedMatrix.map((row, index) => (
                          <tr key={index}>
                            <td><code>{row.provider}/{row.model}</code></td>
                            <td>{row.tool}</td>
                            <td className="harness-eval-caps">{row.capabilities.join(", ") || "—"}</td>
                            <td>{row.attempts}</td>
                            <td>{row.successRate != null ? `${(row.successRate * 100).toFixed(0)}%` : "—"}</td>
                            <td>{row.failures}{row.unknowns > 0 ? ` (+${row.unknowns}?)` : ""}</td>
                            <td>{row.averageLatencyMs != null ? `${row.averageLatencyMs}ms` : "—"}</td>
                            <td>{row.averageInputTokens != null ? `${Math.round(row.averageInputTokens)}/${Math.round(row.averageOutputTokens ?? 0)}` : "—"}</td>
                            <td>{row.averageCostUsd != null ? `$${row.averageCostUsd}` : "—"}</td>
                            <td className="harness-eval-errors">{Object.entries(row.errorCodes).map(([code, count]) => `${code}:${count}`).join(" ") || "—"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  {evalData.decisions.length > 0 && (
                    <div className="harness-section-title" style={{ marginTop: 14 }}>Decisions</div>
                  )}
                </>
              )}
            </section>
          )}

          {tab === "harbor" && (
            <section className="harness-section">
              {!harborData ? (
                <div className="harness-empty">No harbor artifacts yet. Run `npm run eval:cycle` or the budget analyzer.</div>
              ) : (
                <>
                  {harborData.budget && (
                    <>
                      <div className="harness-section-title">Budget comparison (equaxis vs pi_control)</div>
                      <div className="harness-config-grid">
                        {(["equaxis", "pi_control", "gain"] as const).map((name) => {
                          const row = harborData.budget![name] as Record<string, unknown> | undefined;
                          if (!row) return null;
                          return (
                            <div key={name} className="harness-config-card">
                              <b>{name === "gain" ? "Gain" : name}</b>
                              {Object.entries(row).slice(0, 9).map(([key, value]) => (
                                <span key={key}>{key}: {typeof value === "number" ? (Number.isInteger(value) ? String(value) : value.toFixed(3)) : String(value ?? "—")}</span>
                              ))}
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                  {harborData.cycle && (
                    <>
                      <div className="harness-section-title" style={{ marginTop: 14 }}>
                        Improvement cycle · {harborData.cycle.cycleDir ?? harborData.cycle.cycleId ?? "unknown"}
                        {harborData.cycle.generatedAt ? ` · ${formatDate(harborData.cycle.generatedAt)}` : ""}
                      </div>
                      <div className="harness-config-grid">
                        <div className="harness-config-card">
                          <b>Diagnosis</b>
                          {Object.entries(harborData.cycle.diagnosis ?? {}).filter(([key]) => !["taskTable", "capabilityMatrix"].includes(key)).slice(0, 6).map(([key, value]) => {
                            const text = typeof value === "object" ? JSON.stringify(value) : String(value);
                            const display = text.length > 220 ? `${text.slice(0, 219)}…` : text;
                            return <span key={key} title={text.length > 220 ? text : undefined}>{key}: {display}</span>;
                          })}
                        </div>
                        <div className="harness-config-card">
                          <b>Hypotheses</b>
                          <span>{harborData.cycle.hypotheses?.length ?? 0} hypotheses</span>
                          {harborData.cycle.nextIterationFocus && (
                            <span>next focus: {JSON.stringify(harborData.cycle.nextIterationFocus)}</span>
                          )}
                        </div>
                        <div className="harness-config-card">
                          <b>Experiments</b>
                          <span>{harborData.cycle.experiments?.length ?? 0} experiments</span>
                        </div>
                        <div className="harness-config-card">
                          <b>Decisions</b>
                          <span>{harborData.cycle.decisions?.length ?? 0} decisions</span>
                          {(harborData.cycle.decisions ?? []).slice(0, 3).map((decision, index) => (
                            <span key={index}>{typeof decision === "object" ? JSON.stringify(decision) : String(decision)}</span>
                          ))}
                        </div>
                      </div>
                    </>
                  )}
                </>
              )}
            </section>
          )}

          {tab === "files" && (
            <section className="harness-section">
              {openFile ? (
                <>
                  <div className="harness-file-header">
                    <button className="harness-action-btn" onClick={() => { setOpenFile(null); setFileContent(null); }}>← back</button>
                    <code className="harness-file-path">{openFile.path}</code>
                    <span className="harness-file-meta">{fileContent ? `${fileContent.totalLines} lines · ${formatBytes(openFile.bytes)}` : formatBytes(openFile.bytes)}</span>
                  </div>
                  <div className="harness-pagination">
                    <span>{fileContent ? `${fileContent.offset + 1}–${Math.min(fileContent.offset + fileContent.lines.length, fileContent.totalLines)} of ${fileContent.totalLines}` : ""}</span>
                    <button className="harness-action-btn" disabled={!fileContent || fileOffset === 0} onClick={() => fileContent && loadFileContent(openFile, Math.max(0, fileOffset - FILE_PAGE_SIZE))}>← Prev</button>
                    <button className="harness-action-btn" disabled={!fileContent || (fileContent.offset + fileContent.lines.length >= fileContent.totalLines)} onClick={() => fileContent && loadFileContent(openFile, fileOffset + FILE_PAGE_SIZE)}>Next →</button>
                  </div>
                  <div className="harness-file-lines">
                    {fileContent?.lines.map((line) => (
                      <div key={line.n} className="harness-file-line">
                        <code className="harness-line-n">{line.n}</code>
                        <pre className="harness-line-text">{line.text}</pre>
                      </div>
                    ))}
                    {fileContent?.lines.length === 0 && <div className="harness-empty">End of file.</div>}
                  </div>
                </>
              ) : (
                <>
                  <div className="harness-section-title">Runtime artifacts</div>
                  <div className="harness-file-list">
                    {files?.files.map((file) => (
                      <button key={file.path} className="harness-file-item" onClick={() => { setOpenFile(file); loadFileContent(file, 0); }}>
                        <span className={`harness-file-kind${file.exists ? "" : " missing"}`}>{file.exists ? (file.path.endsWith("/") ? "dir" : "file") : "missing"}</span>
                        <code>{file.path}</code>
                        <span className="harness-file-size">{file.exists ? formatBytes(file.bytes) : "—"}</span>
                        {file.modifiedAt && <span className="harness-file-date">{formatDate(file.modifiedAt)}</span>}
                      </button>
                    ))}
                  </div>
                  <div className="harness-section-title">Session files (newest 30)</div>
                  <div className="harness-file-list">
                    {files?.sessionFiles.map((file) => (
                      <button key={file.path} className="harness-file-item" onClick={() => { setOpenFile(file); loadFileContent(file, 0); }}>
                        <span className="harness-file-kind">session</span>
                        <code>{file.path}</code>
                        <span className="harness-file-size">{formatBytes(file.bytes)}</span>
                        {file.modifiedAt && <span className="harness-file-date">{formatDate(file.modifiedAt)}</span>}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
