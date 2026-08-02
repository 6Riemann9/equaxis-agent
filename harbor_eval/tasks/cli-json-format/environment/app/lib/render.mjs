export function renderText(summary) {
  return `Users: ${summary.total}\nActive: ${summary.active}\nNames: ${summary.names.join(", ")}\n`;
}
