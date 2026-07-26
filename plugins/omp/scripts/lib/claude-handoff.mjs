import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ensureAbsolutePath } from "./fs.mjs";

export const TRANSCRIPT_PATH_ENV = "OMP_COMPANION_TRANSCRIPT_PATH";
const CLAUDE_PROJECTS_DIR = path.join(os.homedir(), ".claude", "projects");

function resolveUserPath(cwd, value) {
  if (value === "~") {
    return os.homedir();
  }
  if (String(value).startsWith("~/")) {
    return path.join(os.homedir(), String(value).slice(2));
  }
  return ensureAbsolutePath(cwd, value);
}

export function resolveClaudeSessionPath(cwd, options = {}) {
  const requestedPath = options.source || process.env[TRANSCRIPT_PATH_ENV];
  if (!requestedPath) {
    throw new Error("Could not identify the current Claude transcript. Retry with --source <path-to-claude-jsonl>.");
  }

  const sourcePath = resolveUserPath(cwd, requestedPath);
  if (path.extname(sourcePath) !== ".jsonl") {
    throw new Error(`Claude session source must be a JSONL file: ${sourcePath}`);
  }

  let source;
  let projects;
  try {
    source = fs.realpathSync(sourcePath);
    projects = fs.realpathSync(CLAUDE_PROJECTS_DIR);
  } catch {
    throw new Error(`Claude session file not found: ${sourcePath}`);
  }
  const relative = path.relative(projects, source);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`omp can build a handoff only from sessions under ${CLAUDE_PROJECTS_DIR}: ${source}`);
  }
  return source;
}

function extractMessageText(content) {
  if (typeof content === "string") {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((block) => {
        if (typeof block === "string") {
          return block;
        }
        if (block && typeof block === "object" && typeof block.text === "string") {
          return block.text;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function readTranscriptEntries(sourcePath) {
  const raw = fs.readFileSync(sourcePath, "utf8");
  const entries = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines rather than failing the whole handoff.
    }
  }
  return entries;
}

/**
 * Renders a Claude Code transcript into a condensed markdown handoff document that omp can load
 * directly via its `@file` message-argument convention (`omp "@<handoff>.md"`).
 */
export function buildHandoffMarkdown(sourcePath) {
  const entries = readTranscriptEntries(sourcePath);
  const titleEntry = entries.find((entry) => entry?.type === "custom-title" && entry.customTitle);
  const title = titleEntry?.customTitle || "Claude session handoff";

  const lines = [`# ${title}`, "", `Source: \`${sourcePath}\``, ""];

  for (const entry of entries) {
    if (entry?.type !== "user" && entry?.type !== "assistant") {
      continue;
    }
    const text = extractMessageText(entry.message?.content).trim();
    if (!text) {
      continue;
    }
    const heading = entry.type === "user" ? "### User" : "### Assistant";
    lines.push(heading, "", text, "");
  }

  lines.push(
    "---",
    "",
    "Continue this work: pick up from the most recent turn above and follow through until the task is resolved."
  );

  return `${lines.join("\n")}\n`;
}
