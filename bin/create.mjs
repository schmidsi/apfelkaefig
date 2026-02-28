#!/usr/bin/env node

import { cpSync, mkdirSync, existsSync } from "fs";
import { execSync } from "child_process";
import { resolve, dirname, join } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const templateDir = join(__dirname, "..", "template");

const name = process.argv[2];

if (!name) {
  console.error("Usage: npm init claude-project <project-name>");
  process.exit(1);
}

const target = resolve(name);

if (existsSync(target)) {
  console.error(`Error: ${target} already exists`);
  process.exit(1);
}

mkdirSync(target, { recursive: true });

// Copy template files (including dotfiles)
cpSync(templateDir, target, { recursive: true });

// Init git
execSync("git init", { cwd: target, stdio: "inherit" });
execSync("git add -A", { cwd: target, stdio: "inherit" });

console.log(`\nCreated ${name}/ with Claude Code container template.\n`);
console.log("Next steps:");
console.log(`  cd ${name}`);
console.log("  container build -t claude-sandbox .");
console.log("  ./start.sh");
