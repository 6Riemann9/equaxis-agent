/**
 * Teammate templates: portable, secret-free descriptions of a teammate that
 * can be committed to a repo, shared with a colleague, or used to stamp out
 * a variant under a new name.
 *
 * Deliberately NOT included: ids, stats, inbox messages, queue entries,
 * credentials, session state. A template describes how a teammate *works*,
 * never what it has done — so importing one can never resurrect old authority.
 *
 * Format (versioned; unknown versions are refused rather than guessed):
 *   {
 *     "equaxisCompanionTemplate": 1,
 *     "teammates": [
 *       { "name": "researcher", "persona": "...", "model": "sonnet", "workspace": "researcher" }
 *     ]
 *   }
 * A bare array of teammate objects is also accepted on import (hand-written
 * shorthand), because that is what people actually type.
 */

export const TEMPLATE_VERSION = 1;
export const TEMPLATE_KEY = "equaxisCompanionTemplate";

const FIELD_LIMITS = {
  name: 64,
  persona: 4000,
  workspace: 200,
  model: 200
};

function requireString(value, field, { required = false, max }) {
  if (value === undefined || value === null) {
    if (required) throw new Error(`teammate template: "${field}" is required`);
    return null;
  }
  const text = String(value).trim();
  if (!text) {
    if (required) throw new Error(`teammate template: "${field}" must not be empty`);
    return null;
  }
  if (max && text.length > max) throw new Error(`teammate template: "${field}" is longer than ${max} characters`);
  return text;
}

/** Normalize one teammate entry from a template into store input. */
export function normalizeTemplateTeammate(entry, index = 0) {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`teammate template: entry ${index} must be an object`);
  }
  const known = new Set(["name", "persona", "workspace", "model"]);
  const unknown = Object.keys(entry).filter((key) => !known.has(key));
  if (unknown.length) {
    // Refusing unknown fields keeps templates honest: a typo must not be
    // silently dropped (it usually means the user expected it to do something).
    throw new Error(`teammate template: entry ${index} has unknown field(s): ${unknown.join(", ")}`);
  }
  const name = requireString(entry.name, "name", { required: true, max: FIELD_LIMITS.name });
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(name)) {
    throw new Error(`teammate template: name "${name}" must be kebab-case (letters, digits, -, _)`);
  }
  return {
    name,
    persona: requireString(entry.persona, "persona", { max: FIELD_LIMITS.persona }) ?? "",
    workspace: requireString(entry.workspace, "workspace", { max: FIELD_LIMITS.workspace }) ?? name,
    model: requireString(entry.model, "model", { max: FIELD_LIMITS.model })
  };
}

/** Parse a template document (JSON string or already-parsed value). */
export function parseTemplate(input) {
  let doc;
  if (typeof input === "string") {
    try {
      doc = JSON.parse(input);
    } catch (error) {
      throw new Error(`teammate template is not valid JSON: ${error.message}`);
    }
  } else {
    doc = input;
  }

  if (Array.isArray(doc)) {
    if (!doc.length) throw new Error("teammate template: the array is empty");
    return { version: TEMPLATE_VERSION, teammates: doc.map((entry, index) => normalizeTemplateTeammate(entry, index)) };
  }
  if (typeof doc !== "object" || doc === null) {
    throw new Error("teammate template must be a JSON object or an array of teammates");
  }
  const version = doc[TEMPLATE_KEY];
  if (version !== undefined && version !== TEMPLATE_VERSION) {
    throw new Error(`teammate template version ${version} is not supported (this build understands ${TEMPLATE_VERSION})`);
  }
  if (!Array.isArray(doc.teammates) || !doc.teammates.length) {
    throw new Error(`teammate template must contain a non-empty "teammates" array`);
  }
  return {
    version: TEMPLATE_VERSION,
    teammates: doc.teammates.map((entry, index) => normalizeTemplateTeammate(entry, index))
  };
}

/** Build a template document from live teammate profiles. */
export function buildTemplate(teammates, { names = null } = {}) {
  const selected = names
    ? teammates.filter((teammate) => names.includes(teammate.name))
    : [...teammates];
  if (!selected.length) {
    throw new Error(names
      ? `no teammate matches ${names.join(", ")}`
      : "there are no teammates to export");
  }
  return {
    [TEMPLATE_KEY]: TEMPLATE_VERSION,
    teammates: selected.map((teammate) => ({
      name: teammate.name,
      persona: teammate.persona ?? "",
      workspace: teammate.workspace ?? teammate.name,
      ...(teammate.model ? { model: teammate.model } : {})
    }))
  };
}

/**
 * Apply a parsed template to a store.
 *   rename     — import a single-teammate template under a different name
 *   dryRun     — report the plan without writing
 *   overwrite  — update teammates that already exist (default: skip them)
 */
export function applyTemplate(store, parsed, { rename = null, dryRun = false, overwrite = false } = {}) {
  if (rename && parsed.teammates.length !== 1) {
    throw new Error("--rename can only be used with a single-teammate template");
  }
  const report = { created: [], updated: [], skipped: [], planned: dryRun };

  for (const entry of parsed.teammates) {
    const name = rename ?? entry.name;
    if (rename) {
      if (!/^[a-z0-9][a-z0-9_-]*$/.test(rename)) {
        throw new Error(`--rename value "${rename}" must be kebab-case`);
      }
    }
    const input = {
      name,
      persona: entry.persona,
      workspace: rename ? name : entry.workspace,
      model: entry.model ?? null
    };
    const existing = store.getTeammate(name);
    if (existing) {
      if (!overwrite) {
        report.skipped.push(name);
        continue;
      }
      if (!dryRun) store.updateTeammate(name, input);
      report.updated.push(name);
      continue;
    }
    if (!dryRun) store.createTeammate(input);
    report.created.push(name);
  }
  return report;
}

/** One-line human summary of an apply report. */
export function formatTemplateReport(report) {
  const parts = [];
  if (report.created.length) parts.push(`created ${report.created.map((n) => `@${n}`).join(", ")}`);
  if (report.updated.length) parts.push(`updated ${report.updated.map((n) => `@${n}`).join(", ")}`);
  if (report.skipped.length) parts.push(`skipped (already exists: ${report.skipped.map((n) => `@${n}`).join(", ")} — pass --overwrite)`);
  if (!parts.length) parts.push("nothing to do");
  return `${report.planned ? "[dry run] " : ""}${parts.join("; ")}`;
}
