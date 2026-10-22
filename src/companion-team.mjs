/**
 * Teammate collaboration without a declared pipeline.
 *
 * The human should not have to author the workflow. For that to work, three
 * things the original delegation lacked have to exist:
 *
 *   1. routing      — a teammate may delegate without naming anyone
 *                     (`DELEGATE: instruction`), and the best match wins;
 *   2. lossless handoff — the delegatee receives the delegator's task, its
 *                     result and the files it produced, instead of one line;
 *   3. a closed loop — when the delegatee finishes, its result is delivered
 *                     back to the delegator, which gets a turn to integrate it.
 *
 * Loops are bounded: every hop increments a depth counter and a delegation
 * beyond MAX_DELEGATION_DEPTH is refused with a reason rather than silently
 * ping-ponging two teammates forever.
 */

export const MAX_DELEGATION_DEPTH = 3;

/** Words that carry no routing signal. */
const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "to", "of", "in", "on", "for", "with", "that", "this", "it", "is", "are",
  "please", "then", "into", "from", "by", "as", "at", "be", "do", "does", "should", "would", "can", "could",
  "add", "make", "use", "run", "write", "check", "fix", "update", "create", "review", "test", "tests"
]);

export function tokenizeForRouting(text) {
  const raw = String(text ?? "").toLowerCase().match(/[a-z0-9_]+|[\u4e00-\u9fff]+/g) ?? [];
  const tokens = [];
  for (const chunk of raw) {
    if (/^[\u4e00-\u9fff]+$/.test(chunk)) {
      // Chinese has no spaces, so a sentence arrives as one chunk and can never
      // match a persona token. Overlapping bigrams are the cheap standard fix
      // ("实现代码" -> 实现, 现代, 代码).
      if (chunk.length === 1) tokens.push(chunk);
      for (let i = 0; i + 2 <= chunk.length; i += 1) tokens.push(chunk.slice(i, i + 2));
      continue;
    }
    if (chunk.length > 2 && !STOP_WORDS.has(chunk)) tokens.push(chunk);
  }
  return tokens;
}

/**
 * One line per teammate for the delegator's prompt: names plus personas, so a
 * teammate can choose *who* with understanding instead of guessing a keyword.
 * The worker's lexical router is a cheap first pass; when it cannot decide,
 * the decision goes back to the model that can read these people.
 */
export function formatRoster(teammates, { exclude = null } = {}) {
  const rows = teammates
    .filter((teammate) => teammate.name !== exclude)
    .map((teammate) => `  @${teammate.name} — ${(teammate.persona || "no persona").slice(0, 140)}`);
  return rows.length ? ["", "Your team (delegate by name, or leave the name off and the worker routes it):", ...rows] : [];
}

/**
 * Pick the teammate best matched to an instruction.
 *
 * Scoring is deliberately simple and explainable: token overlap between the
 * instruction and each candidate's persona/name/workspace, with the persona
 * weighted highest because it is the statement of what that teammate is for.
 * Returns null when nothing scores — a wrong guess is worse than refusing,
 * because the delegator can then name someone explicitly.
 */
export function routeTeammate(instruction, teammates, { exclude = null } = {}) {
  const wanted = new Set(tokenizeForRouting(instruction));
  if (wanted.size === 0) return null;

  const scored = [];
  for (const teammate of teammates) {
    if (exclude && teammate.name === exclude) continue;
    const persona = new Set(tokenizeForRouting(teammate.persona));
    const nameTokens = new Set(tokenizeForRouting(`${teammate.name} ${teammate.workspace}`));
    let score = 0;
    const hits = [];
    for (const token of wanted) {
      if (persona.has(token)) {
        score += 3;
        hits.push(token);
      } else if (nameTokens.has(token)) {
        score += 2;
        hits.push(token);
      }
    }
    if (score > 0) scored.push({ teammate, score, hits: [...new Set(hits)] });
  }
  if (!scored.length) {
    // Nothing matched lexically. With exactly one candidate the choice is not
    // really a guess, so take it; otherwise refuse and let the delegator (which
    // can read the roster) name someone.
    const candidates = teammates.filter((teammate) => teammate.name !== exclude);
    if (candidates.length === 1) {
      return { teammate: candidates[0], score: 0, runnerUp: null, reason: "only available teammate (no lexical match)" };
    }
    return null;
  }

  const order = (left, right) =>
    right.score - left.score
    || left.teammate.createdAt.localeCompare(right.teammate.createdAt)
    || left.teammate.name.localeCompare(right.teammate.name);
  const best = scored.sort(order)[0];
  const runnerUp = scored.length > 1 ? scored[1] : null;
  return {
    teammate: best.teammate,
    score: best.score,
    runnerUp: runnerUp ? { name: runnerUp.teammate.name, score: runnerUp.score } : null,
    reason: `matched ${best.hits.join(", ") || "the persona"}${runnerUp ? ` (runner-up @${runnerUp.teammate.name} scored ${runnerUp.score})` : ""}`
  };
}

/** Depth of the hop a delegated task sits at (0 for human-initiated work). */
export function delegationDepth(task) {
  const depth = Number(task?.handoff?.depth);
  return Number.isFinite(depth) && depth > 0 ? depth : 0;
}

/**
 * Build the handoff attached to a delegated task. `result` is the delegator's
 * result so far (its reply has just been parsed), `artifacts` its change list.
 */
export function buildHandoff({ from, task, result, artifacts = null, depth = 0 }) {
  return {
    from: from?.name ?? String(from),
    fromTaskId: task?.id ?? null,
    instruction: String(task?.instruction ?? "").slice(0, 2000),
    summary: String(result ?? "").slice(0, 4000),
    artifacts: artifacts
      ? { added: artifacts.added ?? [], modified: artifacts.modified ?? [], deleted: artifacts.deleted ?? [] }
      : null,
    depth: depth + 1,
    at: new Date().toISOString()
  };
}

/**
 * Render the handoff as prompt context. This is what makes the handoff
 * lossless: the delegatee sees the original ask, what the delegator already
 * learned, and which files exist, without the human re-typing any of it.
 */
export function formatHandoff(handoff) {
  if (!handoff) return [];
  const lines = [];
  lines.push("");
  lines.push(`HANDOFF from @${handoff.from} (delegation depth ${handoff.depth}) — do not ask the human to repeat any of this:`);
  if (handoff.instruction) lines.push(`  original task: ${handoff.instruction}`);
  if (handoff.summary) {
    lines.push("  what they found so far:");
    for (const line of String(handoff.summary).split("\n").slice(0, 20)) lines.push(`    ${line}`);
  }
  const artifacts = handoff.artifacts;
  const changed = artifacts
    ? [
      ...(artifacts.added ?? []).map((entry) => `+ ${entry.path ?? entry}`),
      ...(artifacts.modified ?? []).map((entry) => `~ ${entry.path ?? entry}`),
      ...(artifacts.deleted ?? []).map((entry) => `- ${entry.path ?? entry}`)
    ]
    : [];
  if (changed.length) {
    lines.push("  files they produced in their own workspace (not yours):");
    for (const line of changed.slice(0, 20)) lines.push(`    ${line}`);
  }
  lines.push(`  When done, your result is delivered back to @${handoff.from} automatically — finish your own task, do not wait for them.`);
  return lines;
}

/**
 * The follow-up the delegator gets so a delegation is a conversation rather
 * than a fire-and-forget. Returns null when the loop must stop.
 */
export function buildIntegrationRequest({ delegateTask, delegateTeammate, result, depth }) {
  if (depth > MAX_DELEGATION_DEPTH) {
    return {
      refused: true,
      reason: `delegation depth ${depth} exceeds the cap of ${MAX_DELEGATION_DEPTH} — stopping so teammates cannot ping-pong forever`
    };
  }
  return {
    refused: false,
    instruction: [
      `@${delegateTeammate.name} finished the piece you delegated (task ${String(delegateTask.id).slice(0, 8)}).`,
      "",
      "Their result:",
      String(result ?? "").slice(0, 3000) || "(no result recorded)",
      "",
      "Integrate this into your own work: state what is now complete, what remains, and delegate again only if something is genuinely still missing."
    ].join("\n"),
    runSource: `report:${delegateTeammate.name}`
  };
}
