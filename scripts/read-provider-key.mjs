import fs from "node:fs";
import path from "node:path";

const fromEnvironment = process.env.OPENAI_API_KEY?.trim();
const keyPath = path.resolve(process.cwd(), ".equaxis", "credentials", "openai.key");
const key = fromEnvironment || (fs.existsSync(keyPath) ? fs.readFileSync(keyPath, "utf8").trim() : "");

if (!key) {
  process.stderr.write(
    "OpenAI credential not found. Set OPENAI_API_KEY or create .equaxis/credentials/openai.key.\n"
  );
  process.exit(1);
}

process.stdout.write(key);
