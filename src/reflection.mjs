/** Deterministic post-run reflection; lessons must reference observed trace evidence. */
export function reflectRun(run) {
  const steps = run.steps ?? [];
  const lessons = [];
  const failures = steps.filter((step) => step.status === "failed" || step.isError === true);
  const incomplete = steps.filter((step) => step.errorCode === "RESULT_INCOMPLETE");
  const repeated = new Map();
  for (const step of steps) {
    const key = `${step.toolName ?? "unknown"}:${step.errorCode ?? step.status ?? "ok"}`;
    repeated.set(key, (repeated.get(key) ?? 0) + 1);
  }
  if (failures.length) lessons.push({
    type: "tool_failure",
    evidence: failures.map((step) => step.id).filter(Boolean),
    lesson: "Validate retryability and isolate failed dependencies before continuing."
  });
  if (incomplete.length) lessons.push({
    type: "result_incomplete",
    evidence: incomplete.map((step) => step.id).filter(Boolean),
    lesson: "Require the Result Contract before downstream planning."
  });
  for (const [key, count] of repeated) if (count > 2 && !key.endsWith(":ok")) lessons.push({
    type: "repeated_error",
    evidence: [key],
    lesson: "Stop repeated identical calls earlier and request clarification or human review."
  });
  return {
    goal: run.goal,
    outcome: run.status ?? (failures.length ? "failed" : "completed"),
    lessonCount: lessons.length,
    lessons,
    promotable: lessons.length > 0 && lessons.every((lesson) => lesson.evidence.length > 0)
  };
}

