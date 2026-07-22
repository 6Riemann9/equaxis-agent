const IDENTIFIER = /^[a-z][a-z0-9_]{1,63}$/;

export function lintToolSchema(tool) {
  const errors = [];
  const warnings = [];
  const schema = tool?.inputSchema ?? tool?.parameters;
  if (!tool?.name || !IDENTIFIER.test(String(tool.name))) errors.push("name must be snake_case and 2-64 chars");
  if (!tool?.description || String(tool.description).trim().length < 20) warnings.push("description should explain when and when not to use the tool");
  if (!schema || schema.type !== "object") errors.push("input schema must be an object");
  const properties = schema?.properties ?? {};
  const required = schema?.required ?? [];
  if (Object.keys(properties).length > 12) warnings.push("tool has too many parameters; split by responsibility or use staged operations");
  if (/^(run|execute|handle|manage|do|process)$/i.test(String(tool?.name ?? ""))) warnings.push("generic tool name suggests an overly broad responsibility");
  for (const field of required) if (!Object.hasOwn(properties, field)) errors.push(`required field is not declared: ${field}`);
  if (schema && schema.additionalProperties !== false) warnings.push("set additionalProperties=false to reject hallucinated fields");
  for (const [name, property] of Object.entries(properties)) {
    if (!IDENTIFIER.test(name)) warnings.push(`property should use snake_case: ${name}`);
    if (!property.description) warnings.push(`property needs a description: ${name}`);
    if (property.type === "string" && property.enum && property.enum.length > 12) warnings.push(`enum is too large; use a lookup tool: ${name}`);
    if ((property.type === "integer" || property.type === "number") && property.minimum === undefined && property.maximum === undefined) {
      warnings.push(`numeric property needs a safe range: ${name}`);
    }
  }
  const metadata = tool?.metadata ?? {};
  if (!metadata.risk) warnings.push("declare metadata.risk");
  if (metadata.readOnly === undefined) warnings.push("declare metadata.readOnly");
  if (metadata.readOnly === false && metadata.idempotent !== true) warnings.push("write tools should declare idempotent=true or a compensation strategy");
  return { valid: errors.length === 0, errors, warnings };
}
