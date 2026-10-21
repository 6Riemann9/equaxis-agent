import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseSkillFile, writeSkillFile } from "../src/skill-store.mjs";

test("skill frontmatter mcp declarations are parsed defensively", () => {
  const content = [
    "---",
    'name: pdf-processing',
    "description: Work with PDFs",
    'mcp: [{"name":"pdf-tools","command":"npx","args":["-y","@example/mcp-pdf"],"exposure":"deferred"},{"name":"docs","url":"https://mcp.example.com/docs"}]',
    "---",
    "Procedure body here."
  ].join("\n");
  const skill = parseSkillFile(content, "/tmp/skills/pdf-processing/SKILL.md");
  assert.equal(skill.name, "pdf-processing");
  assert.equal(skill.mcpServers.length, 2);
  assert.deepEqual(skill.mcpServers[0], { name: "pdf-tools", command: "npx", args: ["-y", "@example/mcp-pdf"], exposure: "deferred" });
  assert.equal(skill.mcpServers[1].url, "https://mcp.example.com/docs");
});

test("invalid mcp declarations are dropped without breaking the skill", () => {
  const bad = [
    "---",
    "name: broken",
    "description: still loads",
    'mcp: [{"name":"no transport"},{"name":"bad name!","command":"x"},"not-json',
    "---",
    "Body."
  ].join("\n");
  const skill = parseSkillFile(bad, "/tmp/skills/broken/SKILL.md");
  assert.equal(skill.name, "broken");
  assert.deepEqual(skill.mcpServers, []);
});

test("skills without mcp declarations load with an empty list", () => {
  const plain = "---\nname: plain\ndescription: d\n---\nBody.";
  const skill = parseSkillFile(plain, "/tmp/skills/plain/SKILL.md");
  assert.deepEqual(skill.mcpServers, []);
  const noFrontmatter = parseSkillFile("Just a body.", "/tmp/skills/none/SKILL.md");
  assert.deepEqual(noFrontmatter.mcpServers, []);
});

test("mcp declarations survive a write/read round trip", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "equaxis-skill-mcp-test-"));
  const skill = {
    name: "round-trip",
    description: "d",
    triggers: ["pdf"],
    body: "Steps.",
    mcpServers: [
      { name: "pdf-tools", command: "npx", args: ["-y", "@example/mcp-pdf"], exposure: "deferred", description: "PDF tools" },
      { name: "docs", url: "https://mcp.example.com/docs" }
    ]
  };
  writeSkillFile(dir, skill);
  const filePath = path.join(dir, "round-trip", "SKILL.md");
  const parsed = parseSkillFile(fs.readFileSync(filePath, "utf8"), filePath);
  assert.equal(parsed.mcpServers.length, 2);
  assert.equal(parsed.mcpServers[0].name, "pdf-tools");
  assert.deepEqual(parsed.mcpServers[0].args, ["-y", "@example/mcp-pdf"]);
  assert.equal(parsed.mcpServers[0].exposure, "deferred");
  assert.equal(parsed.mcpServers[1].url, "https://mcp.example.com/docs");
});
