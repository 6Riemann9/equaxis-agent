#!/bin/bash
cat > /app/lib/render.mjs <<'EOF'
export function renderText(summary) {
  return `Users: ${summary.total}\nActive: ${summary.active}\nNames: ${summary.names.join(", ")}\n`;
}

export function renderJson(summary) {
  return `${JSON.stringify(summary)}\n`;
}
EOF
cat > /app/cli.mjs <<'EOF'
#!/usr/bin/env node
import { loadUsers, summarize } from "./lib/users.mjs";
import { renderJson, renderText } from "./lib/render.mjs";

const input = process.argv[2] ?? "users.csv";
const formatIndex = process.argv.indexOf("--format");
const format = formatIndex === -1 ? "text" : process.argv[formatIndex + 1];
if (!new Set(["text", "json"]).has(format)) {
  console.error(`Unsupported format: ${format}`);
  process.exit(2);
}
const summary = summarize(loadUsers(input));
process.stdout.write(format === "json" ? renderJson(summary) : renderText(summary));
EOF
