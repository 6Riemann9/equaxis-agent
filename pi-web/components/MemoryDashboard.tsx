"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { KnowledgeGraph } from "./KnowledgeGraph";

type Drawer = {
  id: string;
  content: string;
  wing: string;
  room: string;
  hall: string;
  source_file?: string;
  filed_at?: string;
  metadata?: Record<string, unknown>;
};
type Fact = { id: string; subject: string; predicate: string; object: string; confidence: number; valid_to?: string | null };
type Snapshot = {
  generated_at: string;
  status: { wings?: Record<string, number>; knowledge_graph?: { entities: number; triples: number; current_facts: number }; config?: { history_entries: number } };
  rooms: Record<string, Record<string, number>>;
  drawers: Drawer[];
  facts: Fact[];
  truncated?: { drawers: boolean; facts: boolean };
};
type SearchMatch = { id: string; content: string; metadata: Record<string, unknown>; score: number };

const hallNames: Record<string, string> = {
  hall_facts: "Facts", hall_events: "Events", hall_discoveries: "Discoveries",
  hall_preferences: "Preferences", hall_advice: "Advice", hall_general: "General",
};
const HALL_OPTIONS = Object.keys(hallNames);

function matchToDrawer(match: SearchMatch): Drawer {
  const metadata = match.metadata ?? {};
  return {
    id: match.id,
    content: match.content,
    wing: typeof metadata.wing === "string" ? metadata.wing : "unknown",
    room: typeof metadata.room === "string" ? metadata.room : "general",
    hall: typeof metadata.hall === "string" ? metadata.hall : "hall_general",
    source_file: typeof metadata.source_file === "string" ? metadata.source_file : "",
    metadata,
  };
}

export function MemoryDashboard({ cwd, onClose }: { cwd: string | null; onClose: () => void }) {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);
  const [query, setQuery] = useState("");
  const [wing, setWing] = useState("all");
  const [view, setView] = useState<"memories" | "graph">("memories");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");

  // Editing
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<Drawer | null>(null);
  const [confirmingDeleteId, setConfirmingDeleteId] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [addDraft, setAddDraft] = useState({ wing: "equaxis", room: "general", hall: "hall_general", content: "" });

  // Semantic search results (null = show local filtered view)
  const [semanticResults, setSemanticResults] = useState<SearchMatch[] | null>(null);
  const [searchingSemantic, setSearchingSemantic] = useState(false);

  const load = useCallback(() => {
    if (!cwd) return;
    setLoading(true);
    setError(null);
    fetch(`/api/memory?cwd=${encodeURIComponent(cwd)}`, { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
        const snapshotValue: Snapshot = body;
        setSnapshot(snapshotValue);
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

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(""), 2500);
  }, []);

  const post = useCallback(async (action: string, payload: Record<string, unknown>) => {
    if (!cwd) throw new Error("No workspace selected");
    const response = await fetch("/api/memory", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ cwd, action, ...payload }),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
    return body;
  }, [cwd]);

  const saveEdit = useCallback(async () => {
    if (!editDraft) return;
    setBusy(true);
    setError(null);
    try {
      await post("update", {
        drawer_id: editDraft.id,
        content: editDraft.content,
        wing: editDraft.wing.trim() || editDraft.wing,
        room: editDraft.room.trim() || editDraft.room,
        hall: editDraft.hall,
        source_file: editDraft.source_file,
      });
      setEditingId(null);
      setEditDraft(null);
      showNotice("Memory updated");
      load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [editDraft, post, load, showNotice]);

  const deleteDrawer = useCallback(async (drawerId: string) => {
    setBusy(true);
    setError(null);
    try {
      await post("delete", { drawer_id: drawerId });
      setConfirmingDeleteId(null);
      showNotice("Memory deleted");
      load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [post, load, showNotice]);

  const addMemory = useCallback(async () => {
    const content = addDraft.content.trim();
    if (!content) return;
    setBusy(true);
    setError(null);
    try {
      await post("remember", {
        content,
        wing: addDraft.wing.trim() || "equaxis",
        room: addDraft.room.trim() || "general",
        hall: addDraft.hall,
        source_file: "pi-web",
      });
      setAddDraft({ wing: addDraft.wing.trim() || "equaxis", room: addDraft.room.trim() || "general", hall: addDraft.hall, content: "" });
      setAdding(false);
      showNotice("Memory added");
      load();
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  }, [addDraft, post, load, showNotice]);

  const runSemanticSearch = useCallback(async () => {
    const text = query.trim();
    if (!text || !cwd) return;
    setSearchingSemantic(true);
    setError(null);
    try {
      const response = await fetch(`/api/memory?cwd=${encodeURIComponent(cwd)}&q=${encodeURIComponent(text)}`, { cache: "no-store" });
      const body = await response.json();
      if (!response.ok) throw new Error(String(body?.error ?? `HTTP ${response.status}`));
      setSemanticResults((body?.matches as SearchMatch[] | undefined) ?? []);
    } catch (reason: unknown) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setSearchingSemantic(false);
    }
  }, [query, cwd]);

  const wings = Object.entries(snapshot?.status.wings ?? {}).sort((a, b) => b[1] - a[1]);
  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (snapshot?.drawers ?? []).filter((item) => {
      if (wing !== "all" && item.wing !== wing) return false;
      return !text || `${item.content} ${item.wing} ${item.room} ${item.hall}`.toLowerCase().includes(text);
    });
  }, [query, snapshot, wing]);
  const facts = useMemo(() => {
    const text = query.trim().toLowerCase();
    return (snapshot?.facts ?? []).filter((fact) => !text || `${fact.subject} ${fact.predicate} ${fact.object}`.toLowerCase().includes(text));
  }, [query, snapshot]);
  const total = Object.values(snapshot?.status.wings ?? {}).reduce((sum, count) => sum + count, 0);

  const visibleDrawers = semanticResults !== null
    ? semanticResults.map(matchToDrawer)
    : filtered;
  const scoreById = useMemo(() => {
    const map = new Map<string, number>();
    for (const match of semanticResults ?? []) map.set(match.id, match.score);
    return map;
  }, [semanticResults]);

  return (
    <div className="memory-dashboard-backdrop" role="dialog" aria-modal="true" aria-label="Equaxis memory">
      <div className="memory-dashboard">
        <header className="memory-dashboard-header">
          <div><div className="memory-kicker">EQUAXIS MEMORY</div><h1>Memory atlas</h1><p>{cwd ?? "No workspace selected"}</p></div>
          <div className="memory-header-actions">
            {notice && <span className="memory-notice">{notice}</span>}
            <button className="memory-icon-button" onClick={load} disabled={loading || busy} title="Refresh memory">{loading ? "..." : "↻"}</button>
            <button className="memory-icon-button" onClick={onClose} title="Close memory">×</button>
          </div>
        </header>
        <div className="memory-dashboard-body">
          {error ? <div className="memory-error">{error}<button onClick={load}>Retry</button></div> : !snapshot ? <div className="memory-empty">{loading ? "Loading memory..." : "Select an Equaxis workspace to inspect memory."}</div> : <>
            <section className="memory-metrics">
              <div><span>Drawers</span><strong>{total}</strong><small>long-term entries</small></div>
              <div><span>Wings</span><strong>{wings.length}</strong><small>memory namespaces</small></div>
              <div><span>Facts</span><strong>{snapshot.status.knowledge_graph?.current_facts ?? 0}</strong><small>current graph links</small></div>
              <div><span>History</span><strong>{snapshot.status.config?.history_entries ?? 0}</strong><small>short-term records</small></div>
            </section>
            <div className="memory-toolbar">
              <div className="memory-tabs">
                <button className={view === "memories" ? "active" : ""} onClick={() => setView("memories")}>Memories</button>
                <button className={view === "graph" ? "active" : ""} onClick={() => setView("graph")}>Knowledge graph</button>
              </div>
              <div className="memory-toolbar-right">
                <button className={adding ? "memory-add-toggle active" : "memory-add-toggle"} onClick={() => { setAdding((value) => !value); setEditingId(null); setEditDraft(null); }} disabled={busy}>+ Add memory</button>
                <input value={query} onChange={(event) => { setQuery(event.target.value); if (!event.target.value.trim()) setSemanticResults(null); }} placeholder="Search memory" aria-label="Search memory" onKeyDown={(event) => { if (event.key === "Enter") void runSemanticSearch(); }} />
                <button className="memory-search-btn" onClick={() => { void runSemanticSearch(); }} disabled={searchingSemantic || !query.trim()}>
                  {searchingSemantic ? "…" : "Semantic"}
                </button>
              </div>
            </div>
            {adding && (
              <div className="memory-add-form">
                <div className="memory-edit-fields">
                  <label>Wing <input value={addDraft.wing} onChange={(event) => setAddDraft((draft) => ({ ...draft, wing: event.target.value }))} /></label>
                  <label>Room <input value={addDraft.room} onChange={(event) => setAddDraft((draft) => ({ ...draft, room: event.target.value }))} /></label>
                  <label>Hall <select value={addDraft.hall} onChange={(event) => setAddDraft((draft) => ({ ...draft, hall: event.target.value }))}>{HALL_OPTIONS.map((hall) => <option key={hall} value={hall}>{hallNames[hall]}</option>)}</select></label>
                </div>
                <textarea value={addDraft.content} onChange={(event) => setAddDraft((draft) => ({ ...draft, content: event.target.value }))} placeholder="New memory content…" />
                <div className="memory-actions">
                  <button className="memory-action-btn" onClick={() => setAdding(false)}>Cancel</button>
                  <button className="memory-action-btn primary" onClick={() => { void addMemory(); }} disabled={busy || !addDraft.content.trim()}>{busy ? "Saving…" : "Save memory"}</button>
                </div>
              </div>
            )}
            {semanticResults !== null && (
              <div className="memory-semantic-header">
                <span>Semantic results for “{query}” ({semanticResults.length})</span>
                <button onClick={() => setSemanticResults(null)}>× clear</button>
              </div>
            )}
            {view === "memories" ? <div className="memory-content-grid">
              <aside className="memory-rail">
                <button className={wing === "all" ? "selected" : ""} onClick={() => setWing("all")}><span>All wings</span><b>{total}</b></button>
                {wings.map(([name, count]) => <button key={name} className={wing === name ? "selected" : ""} onClick={() => setWing(name)}><span>{name}</span><b>{count}</b></button>)}
              </aside>
              <div className="memory-list">
                {visibleDrawers.map((item) => {
                  const isEditing = editingId === item.id;
                  return (
                    <article className="memory-entry" key={item.id}>
                      <div className="memory-entry-meta">
                        <span>{item.wing} / {item.room}</span>
                        <em>{hallNames[item.hall] ?? item.hall}{scoreById.has(item.id) ? ` · ${(scoreById.get(item.id)! * 100).toFixed(0)}%` : ""}</em>
                      </div>
                      {isEditing ? (
                        <div className="memory-edit-area">
                          <div className="memory-edit-fields">
                            <label>Wing <input value={editDraft?.wing ?? item.wing} onChange={(event) => setEditDraft((draft) => (draft ? { ...draft, wing: event.target.value } : draft))} /></label>
                            <label>Room <input value={editDraft?.room ?? item.room} onChange={(event) => setEditDraft((draft) => (draft ? { ...draft, room: event.target.value } : draft))} /></label>
                            <label>Hall <select value={editDraft?.hall ?? item.hall} onChange={(event) => setEditDraft((draft) => (draft ? { ...draft, hall: event.target.value } : draft))}>{HALL_OPTIONS.map((hall) => <option key={hall} value={hall}>{hallNames[hall]}</option>)}</select></label>
                          </div>
                          <textarea value={editDraft?.content ?? item.content} onChange={(event) => setEditDraft((draft) => (draft ? { ...draft, content: event.target.value } : draft))} />
                          <div className="memory-actions">
                            <button className="memory-action-btn" onClick={() => { setEditingId(null); setEditDraft(null); }}>Cancel</button>
                            <button className="memory-action-btn primary" onClick={() => { void saveEdit(); }} disabled={busy}>{busy ? "Saving…" : "Save"}</button>
                          </div>
                        </div>
                      ) : (
                        <>
                          <p>{item.content}</p>
                          <small>{item.source_file || "equaxis"}{item.filed_at ? ` · ${new Date(item.filed_at).toLocaleDateString()}` : ""}</small>
                          <div className="memory-actions">
                            <button className="memory-action-btn" onClick={() => { setEditingId(item.id); setEditDraft({ ...item }); setAdding(false); }} disabled={busy}>Edit</button>
                            <button
                              className={confirmingDeleteId === item.id ? "memory-action-btn danger active" : "memory-action-btn danger"}
                              onClick={() => {
                                if (confirmingDeleteId === item.id) {
                                  void deleteDrawer(item.id);
                                } else {
                                  setConfirmingDeleteId(item.id);
                                  window.setTimeout(() => setConfirmingDeleteId((id) => (id === item.id ? null : id)), 3000);
                                }
                              }}
                              disabled={busy}
                            >
                              {confirmingDeleteId === item.id ? "Confirm delete?" : "Delete"}
                            </button>
                          </div>
                        </>
                      )}
                    </article>
                  );
                })}
                {visibleDrawers.length === 0 && <div className="memory-empty">No memories match this view.</div>}
              </div>
            </div> : <KnowledgeGraph facts={facts} />}
          </>}
        </div>
      </div>
    </div>
  );
}
