#!/usr/bin/env node
import { loadUsers, summarize } from "./lib/users.mjs";
import { renderText } from "./lib/render.mjs";

const input = process.argv[2] ?? "users.csv";
const summary = summarize(loadUsers(input));
process.stdout.write(renderText(summary));
