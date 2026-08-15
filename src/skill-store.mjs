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
    if (key === "triggers" || key === "evidence") {
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
 * Select the most relevant skills under a token budget.
 * Returns selected (with estimatedTokens) and omitted lists.
 */
export function selectRelevantSkills(skills, query, options = {}) {
  const maxTokens = Math.max(1, Math.floor(Number(options.maxTokens ?? 3000)));
  const queryTokens = queryTokensFor(query);
  // Retired skills are excluded from injection: they failed evidence-driven
  // retirement (PracticeUnsafe 2608.12851) and must not resurface in context.
  const active = skills.filter((skill) => skill.retired !== true);
  const scored = active
    .map((skill) => ({ skill, score: scoreSkill(skill, queryTokens) }))
    .filter(({ score }) => score > 0 || queryTokens.length === 0)
    .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name));
  const items = scored.map(({ skill, score }) => ({
    name: skill.name,
    score,
    content: `${skill.description ? `${skill.description}\n` : ""}${skill.body}`,
    skill
  }));
  const { selected, omitted, usedTokens } = selectWithinBudget(items, { maxTokens, requiredNames: options.requiredNames });
  return {
    selected: selected.map((item) => ({ ...item.skill, score: item.score, estimatedTokens: item.estimatedTokens })),
    omitted: omitted.map((item) => ({ name: item.name, reason: item.reason, estimatedTokens: item.estimatedTokens })),
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
  const frontmatter = ["---", `name: ${skill.name}`];
  if (skill.description) frontmatter.push(`description: ${skill.description}`);
  if (skill.triggers?.length) frontmatter.push(`triggers: [${skill.triggers.join(", ")}]`);
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
