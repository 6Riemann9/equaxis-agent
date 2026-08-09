import fs from "node:fs";
import path from "node:path";
import { memoryTier } from "./memory-sharding.mjs";
import { redactTraceValue } from "./trace-store.mjs";

const DEFAULT_RETENTION_DAYS = { hot: 3650, warm: 365, cold: 180 };

function ageDays(record, now) {
  const stamp = Date.parse(record.updatedAt ?? record.createdAt ?? 0);
  if (!Number.isFinite(stamp)) return Infinity;
  return Math.max(0, Math.floor((now - stamp) / 86_400_000));
}

function normalizeRetention(retentionDays = {}) {
  return { ...DEFAULT_RETENTION_DAYS, ...retentionDays };
}

function timestamp(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Date.now();
}

function jsonlRecords(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map((line, index) => {
      try {
        return JSON.parse(line);
      } catch (error) {
        throw new Error(`Invalid memory JSONL at line ${index + 1}: ${error.message}`);
      }
    });
}

function stableRecordId(record, index) {
  return String(record.id ?? record.memoryId ?? record.key ?? index);
}

export function redactMemoryRecord(record) {
  return redactTraceValue(structuredClone(record));
}

export function auditMemoryRecords(records, options = {}) {
  const now = timestamp(options.now ?? Date.now());
  const retention = normalizeRetention(options.retentionDays);
  const keep = [];
  const remove = [];
  for (const [index, record] of records.entries()) {
    const tier = memoryTier(record, now);
    const age = ageDays(record, now);
    const ttl = retention[tier] ?? DEFAULT_RETENTION_DAYS[tier] ?? DEFAULT_RETENTION_DAYS.cold;
    const protectedRecord = Boolean(record.pinned || record.kind === "profile" || record.importance >= 0.7);
    const entry = { id: stableRecordId(record, index), tier, ageDays: age, ttlDays: ttl, record };
    if (!protectedRecord && age > ttl) remove.push({ ...entry, reason: `expired ${tier} memory` });
    else keep.push({ ...entry, reason: protectedRecord ? "protected memory" : "within retention" });
  }
  return {
    keep,
    delete: remove,
    summary: { total: records.length, keep: keep.length, delete: remove.length }
  };
}

export function applyMemoryGovernance(options = {}) {
  const started = Date.now();
  const inputPath = path.resolve(options.inputPath);
  const lockPath = path.resolve(options.lockPath ?? `${inputPath}.lock`);
  let lockHandle = null;
  try {
    if (options.apply) {
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      try {
        lockHandle = fs.openSync(lockPath, "wx");
        fs.writeFileSync(lockHandle, `${process.pid}\n`, "utf8");
      } catch (error) {
        if (error?.code === "EEXIST") throw new Error(`memory governance lock already held: ${lockPath}`);
        throw error;
      }
    }

    const records = jsonlRecords(inputPath);
    const audit = auditMemoryRecords(records, options);
    const deleteIds = new Set(audit.delete.map((item) => item.id));
    const retained = records
      .map((record, index) => ({ id: stableRecordId(record, index), record }))
      .filter((item) => !deleteIds.has(item.id));
    const kept = retained.map((item) => redactMemoryRecord(item.record));
    const redactedRecords = kept.filter((record, index) => JSON.stringify(record) !== JSON.stringify(retained[index].record));

    if (options.apply) {
      const content = kept.map((record) => JSON.stringify(record)).join("\n") + (kept.length ? "\n" : "");
      fs.mkdirSync(path.dirname(inputPath), { recursive: true });
      fs.writeFileSync(inputPath, content, "utf8");
    }

    return {
      inputPath,
      lockPath,
      written: Boolean(options.apply),
      keptRecords: kept,
      deletedRecords: audit.delete,
      redactedRecords: redactedRecords.length,
      durationMs: Date.now() - started,
      audit
    };
  } finally {
    if (lockHandle !== null) {
      fs.closeSync(lockHandle);
      fs.rmSync(lockPath, { force: true });
    }
  }
}

export function formatMemoryGovernanceReport(report) {
  return [
    "Equaxis memory governance",
    `Input: ${report.inputPath}`,
    `Records: ${report.audit.summary.total}`,
    `Kept: ${report.audit.summary.keep}`,
    `Deleted: ${report.audit.summary.delete}`,
    `Written: ${report.written ? "yes" : "no"}`
  ].join("\n");
}
