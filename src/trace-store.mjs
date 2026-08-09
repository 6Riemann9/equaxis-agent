import fs from "node:fs";
import path from "node:path";

const SENSITIVE_KEY = /^(?:api[_-]?key|password|secret|token|access[_-]?token|auth(?:orization)?|private[_-]?key)$/i;
const SECRET_ASSIGNMENT = /(\b(?:api[_-]?key|password|secret|token|access[_-]?token|auth[_-]?token|private[_-]?key)\b\s*["']?\s*[:=]\s*["']?)([^\s"',;}]{8,})/gi;
const BEARER = /(\bBearer\s+)[A-Za-z0-9._~+/=-]{12,}/gi;
const KNOWN_TOKEN = /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AKIA[A-Z0-9]{16})\b/g;

export function redactTraceValue(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (typeof value === "string") {
    return value
      .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
      .replace(BEARER, "$1[REDACTED]")
      .replace(KNOWN_TOKEN, "[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redactTraceValue(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactTraceValue(child, childKey)]));
  }
  return value;
}

export class RotatingJsonlTrace {
  constructor(filePath, options = {}) {
    this.filePath = path.resolve(filePath);
    this.maxFileBytes = options.maxFileBytes ?? 5 * 1024 * 1024;
    this.maxFiles = options.maxFiles ?? 3;
  }

  archivePath(index) {
    const extension = path.extname(this.filePath);
    const stem = extension ? this.filePath.slice(0, -extension.length) : this.filePath;
    return `${stem}.${index}${extension}`;
  }

  rotate(nextBytes) {
    if (!fs.existsSync(this.filePath)) return;
    const currentBytes = fs.statSync(this.filePath).size;
    if (currentBytes === 0 || currentBytes + nextBytes <= this.maxFileBytes) return;
    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const destination = this.archivePath(index);
      const source = index === 1 ? this.filePath : this.archivePath(index - 1);
      if (fs.existsSync(destination)) fs.rmSync(destination, { force: true });
      if (fs.existsSync(source)) fs.renameSync(source, destination);
    }
    if (this.maxFiles === 1) fs.rmSync(this.filePath, { force: true });
  }

  append(record) {
    const line = `${JSON.stringify(redactTraceValue(record))}\n`;
    const bytes = Buffer.byteLength(line, "utf8");
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.rotate(bytes);
    fs.appendFileSync(this.filePath, line, "utf8");
  }
}
