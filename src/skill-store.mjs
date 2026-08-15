import fs from "node:fs";
import path from "node:path";
import { selectWithinBudget } from "./context-budget.mjs";

/**
 * Skill store: load, score, and select procedural skills (SKILL.md).
 *
 * Mirrors the tool-catalog scoring style and reuses context-budget's budget
 * selection so skills are injected into context only when relevant and under a
 * hard token budget. Skill bodies are treated as untrusted reference material,
 * not executable instructions.
 */

/** Parse frontmatter (---\n...\n---) + body from a SKILL.md file. */
export function parseSkillFile(content, filePath = "") {
  const text = String(content ?? "");
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!match) {
    const fallbackName = path.basename(path.dirname(filePath)) || "untitled";
    return {
      name: fallbackName,
      description: "",
      triggers: [],
      body: text.trim(),
      filePath,
      baseDir: path.dirname(filePath)
    };
  }
  const rawFrontmatter = match[1];
  const body = (match[2] ?? "").trim();
  const meta = {};
  for (const line of rawFrontmatter.split(/\r?\n/)) {
    const sep = line.indexOf(":");
    if (sep === -1) continue;
    const key = line.slice(0, sep).trim().toLowerCase();
    const value = line.slice(sep + 1).trim();
    if (key === "triggers" || key === "evidence" || key === "related") {
      meta[key] = value.replace(/^\[|\]$/g, "").split(",").map((s) => s.trim()).filter(Boolean);
    } else if (key === "retired") {
      meta[key] = value.toLowerCase() === "true";
    } else {
      meta[key] = value;
    }
  }
  return {
    name: meta.name || path.basename(path.dirname(filePath)) || "untitled",
    description: meta.description ?? "",
    triggers: meta.triggers ?? [],
    evidence: meta.evidence ?? [],
    // Google Agent Skills metadata: category for registry-style filtering,
    // dontUse for explicit negative space ("DON'T use this skill for X"),
    // related for cross-links to sibling skills (agentskills.io standard).
    category: meta.category ?? "",
    dontUse: meta.dontuse ?? "",
    related: meta.related ?? [],
    source: meta.source ?? "",
    created: meta.created ?? "",
    retired: meta.retired ?? false,
    retiredReason: meta.retiredreason ?? "",
    body,
    filePath,
    baseDir: path.dirname(filePath)
  };
}

/** Recursively load all SKILL.md files under a directory. */
export function loadSkillsFromDirectory(dir, options = {}) {
  const readFile = options.readFile ?? ((file) => fs.readFileSync(file, "utf-8"));
  if (!fs.existsSync(dir)) return [];
  const skills = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase() === "skill.md") {
        try {
          skills.push(parseSkillFile(readFile(full), full));
        } catch {
          // Skip a malformed/unreadable skill rather than failing the load.
        }
      }
    }
  };
  walk(dir);
  return skills;
}

const tokenize = (value) => String(value ?? "").toLowerCase().split(/[^\p{L}\p{N}_-]+/u).filter(Boolean);

const STOPWORDS = new Set([
  "a", "an", "the", "to", "of", "in", "on", "for", "with", "at", "by", "from",
  "is", "are", "was", "were", "be", "and", "or", "but", "not", "how", "what",
  "when", "why", "which", "this", "that", "it", "do", "does", "use", "using"
]);

/** Query tokens with common stopwords removed so substring scoring is not noise-dominated. */
function queryTokensFor(value) {
  return tokenize(value).filter((token) => !STOPWORDS.has(token));
}

/** Score a skill against query tokens. Name > triggers > description. */
export function scoreSkill(skill, queryTokens) {
  const nameTokens = tokenize(skill.name.replaceAll("-", " ").replaceAll("_", " "));
  const triggerTokens = tokenize((skill.triggers ?? []).join(" "));
  const descriptionTokens = tokenize(skill.description);
  const nameSet = new Set(nameTokens);
  let score = 0;
  for (const token of queryTokens) {
    if (nameSet.has(token)) score += 5;
    else if (triggerTokens.includes(token)) score += 3;
    else if (descriptionTokens.includes(token)) score += 2;
    else if (nameTokens.some((candidate) => candidate.includes(token) || token.includes(candidate))) score += 1;
  }
  return score;
}

/**
 * Negative-space tokens (Google Agent Skills "DON'T use for X"): skills
 * whose dontUse text matches the query are excluded from injection so
 * wrong-skill context never surfaces.
 */
export function negativeSpaceTokens(skill) {
  return new Set(tokenize(skill.dontUse));
}

/**
 * Select the most relevant skills under a token budget.
 * Returns selected (with estimatedTokens) and omitted lists.
 */
export function selectRelevantSkills(skills, query, options = {}) {
  const maxTokens = Math.max(1, Math.floor(Number(options.maxTokens ?? 3000)));
  const queryTokens = queryTokensFor(query);
  // Retired skills are excluded from injection: they failed evidence-driven
  // retirement (PracticeUnsafe 2608.12851) and must not resurface in context.
  const active = skills.filter((skill) => skill.retired !== true);
  const scored = [];
  const omitted = [];
  for (const skill of active) {
    const score = scoreSkill(skill, queryTokens);
    if (score <= 0 && queryTokens.length > 0) continue;
    const negativeTokens = negativeSpaceTokens(skill);
    const negativeHit = queryTokens.some((token) => negativeTokens.has(token));
    if (negativeHit) {
      omitted.push({ name: skill.name, reason: "negative_space", estimatedTokens: 0 });
      continue;
    }
    scored.push({ skill, score });
  }
  scored.sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  const items = scored.map(({ skill, score }) => ({
    name: skill.name,
    score,
    content: `${skill.description ? `${skill.description}\n` : ""}${skill.body}`,
    skill
  }));
  // Related-skill expansion (agentskills.io "Related Skills"): a selected
  // skill's declared related skills are pulled in at the anchor's score so
  // composite workflows reuse atomic skills without separate queries.
  if (options.followRelated !== false) {
    const byName = new Map(active.map((skill) => [skill.name, skill]));
    const selectedNames = new Set(items.map((item) => item.name));
    const relatedItems = [];
    for (const item of items) {
      for (const relatedName of item.skill.related ?? []) {
        const related = byName.get(relatedName);
        if (!related || selectedNames.has(relatedName)) continue;
        selectedNames.add(relatedName);
        const relatedScore = Math.max(item.score, scoreSkill(related, queryTokens));
        relatedItems.push({
          name: related.name,
          score: relatedScore,
          content: `${related.description ? `${related.description}\n` : ""}${related.body}`,
          skill: related,
          viaRelated: item.name
        });
      }
    }
    items.push(...relatedItems);
  }
  const { selected, omitted: budgetOmitted, usedTokens } = selectWithinBudget(items, { maxTokens, requiredNames: options.requiredNames });
  return {
    selected: selected.map((item) => ({ ...item.skill, score: item.score, estimatedTokens: item.estimatedTokens, viaRelated: item.viaRelated ?? null })),
    omitted: [...omitted, ...budgetOmitted.map((item) => ({ name: item.name, reason: item.reason, estimatedTokens: item.estimatedTokens }))],
    usedTokens,
    maxTokens
  };
}

/** Render a skill as an injected block, matching Pi's <skill> reference format. */
export function renderSkillBlock(skill) {
  const body = String(skill.body ?? "").trim();
  const name = String(skill.name ?? "untitled");
  const location = String(skill.filePath ?? "");
  const lines = [];
  if (skill.description) lines.push(`> ${skill.description}`);
  lines.push(`<skill name="${name}"${location ? ` location="${location}"` : ""}>`);
  if (skill.baseDir) lines.push(`References are relative to ${skill.baseDir}.`);
  lines.push(body);
  lines.push(`</skill>`);
  return lines.join("\n");
}

const LESSON_TRIGGERS = {
  tool_failure: ["tool", "failure", "retry", "error"],
  result_incomplete: ["result", "contract", "validation"],
  repeated_error: ["retry", "loop", "clarify", "ask"]
};

/** Slugify a lesson type into a stable skill name fragment. */
function slugifyLessonType(type) {
  return String(type ?? "").replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "").toLowerCase() || "lesson";
}

/**
 * Deterministically derive a skill draft from an evidence-backed run reflection.
 * Returns null when the run has no promotable lessons (no evidence), so an empty
 * run never invents a procedure. The lesson body is copied verbatim from the
 * reflection; no model is involved in this derivation.
 */
export function deriveSkillFromRun(run) {
  const lessons = (run?.lessons ?? []).filter((lesson) => (lesson.evidence?.length ?? 0) > 0);
  if (!lessons.length) return null;
  const primary = lessons[0];
  const evidenceIds = lessons.flatMap((lesson) => lesson.evidence ?? []);
  const slug = slugifyLessonType(primary.type);
  const body = lessons.map((lesson) => `- ${lesson.lesson}`).join("\n");
  return {
    name: `reliability-${slug}`,
    description: `Evidence-backed procedure derived from a failed run (goal: ${String(run.goal ?? "").slice(0, 80)}).`,
    triggers: LESSON_TRIGGERS[primary.type] ?? ["failure"],
    body: `## When to apply\n\nA run failed with evidence from: ${evidenceIds.join(", ")}.\n\n## Procedure\n\n${body}`,
    evidence: evidenceIds,
    sourceRun: run.goal
  };
}

/** Serialize a skill back to SKILL.md so learn/manage can persist it. */
export function serializeSkill(skill) {
  // Sanitize frontmatter values: newlines would forge metadata lines and
  // colons would truncate the key (parseSkillFile splits at the first ':').
  const oneLine = (value) => String(value ?? "").replace(/[\r\n:]+/g, " ").trim();
  const frontmatter = ["---", `name: ${oneLine(skill.name)}`];
  if (skill.description) frontmatter.push(`description: ${oneLine(skill.description)}`);
  if (skill.triggers?.length) frontmatter.push(`triggers: [${skill.triggers.join(", ")}]`);
  if (skill.category) frontmatter.push(`category: ${oneLine(skill.category)}`);
  if (skill.dontUse) frontmatter.push(`dontUse: ${oneLine(skill.dontUse)}`);
  if (skill.related?.length) frontmatter.push(`related: [${skill.related.join(", ")}]`);
  // Provenance (血缘): evidence-backed skills stay auditable after deploy.
  // PracticeUnsafe (2608.12851) shows unsafe successes harden into skills and
  // get reused across sessions; persisting source+evidence makes every skill
  // traceable to the run that produced it.
  if (skill.evidence?.length) frontmatter.push(`evidence: [${skill.evidence.join(", ")}]`);
  if (skill.source) frontmatter.push(`source: ${String(skill.source).replace(/\n/g, " ")}`);
  if (!skill.created && (skill.evidence?.length || skill.source)) frontmatter.push(`created: ${new Date().toISOString()}`);
  if (skill.created) frontmatter.push(`created: ${skill.created}`);
  if (skill.retired === true) {
    frontmatter.push("retired: true");
    if (skill.retiredReason) frontmatter.push(`retiredReason: ${String(skill.retiredReason).replace(/\n/g, " ")}`);
  }
  frontmatter.push("---");
  return `${frontmatter.join("\n")}\n\n${String(skill.body ?? "").trim()}\n`;
}

/** Write a skill as SKILL.md under dir (returns the file path). */
export function writeSkillFile(dir, skill, options = {}) {
  const writeFile = options.writeFile ?? fs.writeFileSync;
  fs.mkdirSync(dir, { recursive: true });
  const name = String(skill.name ?? "").trim().replace(/[^a-z0-9-]+/gi, "-").toLowerCase();
  if (!name) throw new Error("skill name is required");
  const skillDir = path.join(dir, name);
  fs.mkdirSync(skillDir, { recursive: true });
  const filePath = path.join(skillDir, "SKILL.md");
  writeFile(filePath, serializeSkill(skill), "utf-8");
  return filePath;
}
