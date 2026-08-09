import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const fromEnvironment = process.env.OPENAI_API_KEY?.trim();
const installRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const keyPaths = [
  path.resolve(process.cwd(), ".equaxis", "credentials", "openai.key"),
  path.resolve(installRoot, ".equaxis", "credentials", "openai.key")
];
const keyPath = keyPaths.find((candidate) => fs.existsSync(candidate));
const key = fromEnvironment || (keyPath ? fs.readFileSync(keyPath, "utf8").trim() : "");

if (!key) {
  process.stderr.write(
    "OpenAI credential not found. Set OPENAI_API_KEY or create .equaxis/credentials/openai.key.\n"
  );
  process.exit(1);
}

process.stdout.write(key);
