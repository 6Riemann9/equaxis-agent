export class MockToolRegistry {
  constructor() {
    this.tools = new Map();
    this.calls = [];
  }

  register(name, options = {}) {
    if (this.tools.has(name)) throw new Error(`mock tool already registered: ${name}`);
    this.tools.set(name, {
      response: options.response,
      error: options.error,
      delayMs: Math.max(0, Number(options.delayMs ?? 0)),
      once: options.once === true,
      calls: 0
    });
    return this;
  }

  async invoke(name, args = {}, context = {}) {
    const definition = this.tools.get(name);
    if (!definition) throw new Error(`mock tool not registered: ${name}`);
    definition.calls += 1;
    const call = { name, args: structuredClone(args), context: { ...context }, callIndex: this.calls.length };
    this.calls.push(call);
    if (definition.delayMs) await new Promise((resolve) => setTimeout(resolve, definition.delayMs));
    if (definition.once && definition.calls > 1) throw new Error(`mock tool called more than once: ${name}`);
    if (definition.error) throw (definition.error instanceof Error ? definition.error : new Error(String(definition.error)));
    return typeof definition.response === "function"
      ? definition.response(args, context)
      : structuredClone(definition.response ?? { ok: true });
  }

  callsFor(name) { return this.calls.filter((call) => call.name === name); }

  assertCalled(name, count = 1) {
    const actual = this.callsFor(name).length;
    if (actual !== count) throw new Error(`expected ${name} to be called ${count} time(s), got ${actual}`);
  }

  assertNeverCalled(name) { this.assertCalled(name, 0); }
}

export function generatedBoundaryCases(spec) {
  const cases = [{ name: "valid", args: structuredClone(spec.validArgs ?? {}) }];
  for (const field of spec.requiredStrings ?? []) {
    cases.push({ name: `${field}_missing`, args: { ...structuredClone(spec.validArgs ?? {}), [field]: "" } });
    cases.push({ name: `${field}_wrong_type`, args: { ...structuredClone(spec.validArgs ?? {}), [field]: 42 } });
  }
  for (const [field, boundary] of Object.entries(spec.numericBounds ?? {})) {
    cases.push({ name: `${field}_below_min`, args: { ...structuredClone(spec.validArgs ?? {}), [field]: boundary.min - 1 } });
    cases.push({ name: `${field}_above_max`, args: { ...structuredClone(spec.validArgs ?? {}), [field]: boundary.max + 1 } });
  }
  return cases;
}

