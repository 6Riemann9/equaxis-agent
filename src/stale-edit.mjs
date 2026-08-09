import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export function hashText(text) {
  return crypto.createHash("sha256").update(String(text), "utf8").digest("hex");
}

function collectOldTexts(input) {
  if (typeof input?.oldText === "string") return [input.oldText];
  if (Array.isArray(input?.edits)) {
    return input.edits
      .map((edit) => edit?.oldText)
      .filter((oldText) => typeof oldText === "string");
  }
  return [];
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let offset = 0;
  while (true) {
    const index = text.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

export function validateEditFreshness(toolName, input, options = {}) {
  if (toolName !== "edit") return null;
  const targetPath = String(input?.path ?? "").trim();
  if (!targetPath) return null;
  const cwd = path.resolve(options.cwd ?? process.cwd());
  const absolutePath = path.resolve(cwd, targetPath);
  if (!fs.existsSync(absolutePath)) {
    return { code: "STALE_EDIT_FILE_MISSING", field: "path", message: "edit target does not exist", retryable: true };
  }
  const text = fs.readFileSync(absolutePath, "utf8");
  const expectedHash = typeof input?.expectedHash === "string" ? input.expectedHash.trim().toLowerCase() : "";
  const actualHash = hashText(text);
  if (expectedHash && expectedHash !== actualHash) {
    return {
      code: "STALE_EDIT_HASH_MISMATCH",
      field: "expectedHash",
      message: "edit target hash changed since it was read",
      retryable: true,
      expectedHash,
      actualHash
    };
  }
  const oldTexts = collectOldTexts(input);
  if (oldTexts.length === 0) return null;
  for (const oldText of oldTexts) {
    const occurrences = countOccurrences(text, oldText);
    if (occurrences === 0) {
      return { code: "STALE_EDIT_OLD_TEXT_MISSING", field: "oldText", message: "oldText no longer matches target file", retryable: true, actualHash };
    }
    if (occurrences > 1) {
      return { code: "STALE_EDIT_OLD_TEXT_AMBIGUOUS", field: "oldText", message: "oldText matches multiple regions", retryable: true, occurrences, actualHash };
    }
  }
  return null;
}
