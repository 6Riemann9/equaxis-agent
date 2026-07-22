const DEFAULT_MAX_CONCURRENCY = 4;

function normalizeTask(task) {
  if (!task || typeof task !== "object") throw new Error("task must be an object");
  const id = String(task.id ?? "").trim();
  const toolName = String(task.toolName ?? "").trim();
  if (!id || !toolName) throw new Error("task id and toolName are required");
  return {
    id,
    toolName,
    dependsOn: [...new Set((task.dependsOn ?? []).map(String))],
    readOnly: task.readOnly !== false,
    risk: String(task.risk ?? "low"),
    priority: Number.isFinite(Number(task.priority)) ? Number(task.priority) : 0,
    estimatedMs: Math.max(0, Number(task.estimatedMs ?? 0))
  };
}

function assertAcyclic(tasks) {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!byId.has(dependency)) throw new Error(`unknown dependency: ${dependency}`);
    }
  }
  const visiting = new Set();
  const visited = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error(`dependency cycle detected at: ${id}`);
    if (visited.has(id)) return;
    visiting.add(id);
    for (const dependency of byId.get(id).dependsOn) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  }
  for (const task of tasks) visit(task.id);
}

/** Create deterministic execution waves from a dependency graph. */
export function scheduleTools(input, options = {}) {
  const tasks = input.map(normalizeTask);
  if (new Set(tasks.map((task) => task.id)).size !== tasks.length) throw new Error("duplicate task id");
  assertAcyclic(tasks);
  const maxConcurrency = Math.max(1, Math.floor(Number(options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY)));
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const completed = new Set();
  const remaining = new Set(tasks.map((task) => task.id));
  const waves = [];

  while (remaining.size) {
    const ready = [...remaining]
      .map((id) => byId.get(id))
      .filter((task) => task.dependsOn.every((dependency) => completed.has(dependency)))
      .sort((left, right) => right.priority - left.priority || left.id.localeCompare(right.id));
    if (!ready.length) throw new Error("unable to make scheduling progress");

    const wave = [];
    // Gather reversible evidence first; isolate writes and high-risk work in their own wave.
    const safeReads = ready.filter((task) => task.readOnly && task.risk !== "high" && task.risk !== "blocked");
    const sideEffect = ready.find((task) => !task.readOnly || task.risk === "high" || task.risk === "blocked");
    if (safeReads.length) wave.push(...safeReads.slice(0, maxConcurrency));
    else if (sideEffect) wave.push(sideEffect);
    for (const task of wave) {
      remaining.delete(task.id);
      completed.add(task.id);
    }
    waves.push(wave);
  }

  return {
    waves: waves.map((wave, index) => ({ wave: index, tasks: wave })),
    waveCount: waves.length,
    maxParallelism: Math.max(0, ...waves.map((wave) => wave.length)),
    estimatedCriticalPathMs: waves.reduce((total, wave) => total + Math.max(...wave.map((task) => task.estimatedMs), 0), 0)
  };
}
