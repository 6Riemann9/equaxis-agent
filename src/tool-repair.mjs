/**
 * Bounded repair bookkeeping for tool validation failures.
 * This module never mutates model arguments; it only decides whether a
 * retryable validation error may be shown to the model again.
 */
export const DEFAULT_MAX_REPAIR_ATTEMPTS = 2;

export function repairKey(toolName, validation) {
  return `${toolName}:${validation.code}:${validation.field ?? "_"}`;
}

export function registerRepairAttempt(
  attempts,
  toolName,
  validation,
  maxAttempts = DEFAULT_MAX_REPAIR_ATTEMPTS
) {
  const key = repairKey(toolName, validation);
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  return {
    key,
    attempt,
    maxAttempts,
    allowed: validation.retryable === true && attempt <= maxAttempts
  };
}

export function validationFeedback(toolName, validation, repair) {
  return {
    ok: false,
    errorCode: validation.code,
    tool: toolName,
    field: validation.field,
    message: validation.message,
    retryable: validation.retryable === true && repair.allowed,
    attempt: repair.attempt,
    maxAttempts: repair.maxAttempts
  };
}

