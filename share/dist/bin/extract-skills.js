import fs from "node:fs";
import { extractSkillProvenance } from "../src/lib/skills.js";
import { readSkillMdFor } from "../src/lib/skill-paths.js";
const path = process.argv[2];
if (!path) {
    console.error("usage: extract-skills <transcript.jsonl>");
    process.exit(2);
}
const jsonl = fs.readFileSync(path, "utf-8");
// Extract unique skill names from <command-name> tags in user turns.
// Skills are slash commands in the form "publisher:skill-name" or bare "skill-name".
// Built-in Claude Code commands (single word, no colon, and in a known denylist)
// are excluded — they carry no SKILL.md and no publisher provenance.
const BUILTIN_COMMANDS = new Set([
    "share", "clear", "help", "exit", "quit", "config", "login", "logout",
    "init", "doctor", "status", "review", "bug", "compact", "cost", "memory",
    "vim", "editor", "model", "settings", "add-dir", "ide",
]);
function isBuiltin(name) {
    // Commands with a colon are publisher-namespaced — always external skills
    if (name.includes(":"))
        return false;
    return BUILTIN_COMMANDS.has(name.toLowerCase());
}
const CMD_RE = /<command-name>([^<]+)<\/command-name>/g;
const seen = new Set();
for (const line of jsonl.split("\n")) {
    const s = line.trim();
    if (!s)
        continue;
    let rec;
    try {
        rec = JSON.parse(s);
    }
    catch {
        continue;
    }
    if (rec["type"] !== "user")
        continue;
    if (rec["isMeta"] === true || rec["isCompactSummary"] === true || rec["isSidechain"] === true)
        continue;
    const msg = (rec["message"] ?? {});
    const content = msg["content"];
    const text = typeof content === "string"
        ? content
        : Array.isArray(content)
            ? content
                .filter((b) => b && typeof b === "object" && b["type"] === "text")
                .map((b) => String(b["text"] ?? ""))
                .join("\n")
            : "";
    for (const m of text.matchAll(CMD_RE)) {
        const name = m[1].trim();
        if (name && !isBuiltin(name))
            seen.add(name);
    }
}
const skillNames = Array.from(seen);
process.stdout.write(JSON.stringify(extractSkillProvenance(skillNames, readSkillMdFor)));
