const getPath = (value, path) => String(path).split(".").reduce((current, key) => current?.[key], value);

export function validateToolResult(toolName, result, contract = {}) {
  const warnings = [];
  const missing = [];
  if (result === null || result === undefined) {
    return { toolName, complete: false, usable: false, confidence: 0, missing: ["result"], warnings: ["empty result"] };
  }
  if (typeof result !== "object") {
    return { toolName, complete: false, usable: false, confidence: 0, missing: ["result.object"], warnings: ["result is not an object"] };
  }
  if (result.ok === false) {
    return { toolName, complete: false, usable: false, confidence: 0, missing: [], warnings: ["tool reported ok=false"] };
  }
  for (const path of contract.required ?? []) {
    const value = getPath(result, path);
    if (value === undefined || value === null || value === "" || (Array.isArray(value) && value.length === 0)) missing.push(path);
  }
  for (const path of contract.nonEmptyArrays ?? []) {
    const value = getPath(result, path);
    if (!Array.isArray(value) || value.length === 0) warnings.push(`${path} is empty`);
  }
  if (contract.requiresEvidence && !((result.evidence ?? result.data?.evidence)?.length > 0)) {
    missing.push("evidence");
  }
  if (typeof contract.predicate === "function") {
    try {
      if (!contract.predicate(result)) warnings.push("custom semantic predicate failed");
    } catch (error) {
      warnings.push(`predicate error: ${String(error)}`);
    }
  }
  const complete = missing.length === 0 && warnings.length === 0;
  return {
    toolName,
    complete,
    usable: missing.length === 0,
    confidence: complete ? 1 : missing.length ? 0 : 0.5,
    missing,
    warnings
  };
}

export function createResultMiddleware(contracts = {}) {
  return async function resultMiddleware(task, rawResult) {
    const validation = validateToolResult(task.toolName, rawResult, contracts[task.toolName]);
    if (!validation.complete) {
      const error = new Error(`RESULT_INCOMPLETE: ${JSON.stringify(validation)}`);
      error.code = "RESULT_INCOMPLETE";
      error.validation = validation;
      throw error;
    }
    return { data: rawResult, validation };
  };
}

