// packages/ef-share-plugin/src/lib/skill-paths.ts
//
// Filesystem helpers for locating a skill's SKILL.md.
// Search order:
//   1. Walk from `cwd` up to the root, checking <dir>/.claude/skills/<name>/SKILL.md.
//   2. Check <home>/.claude/skills/<name>/SKILL.md.
// Returns null on any error (best-effort).
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
/**
 * Search for <name>/SKILL.md starting at `cwd` and walking up ancestors,
 * then falling back to `home`. Returns the first absolute path that exists,
 * or null if none do.
 */
export function findSkillMd(name, cwd, home) {
    // Walk cwd upward
    let dir = path.resolve(cwd);
    while (true) {
        const candidate = path.join(dir, ".claude", "skills", name, "SKILL.md");
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // reached filesystem root
        dir = parent;
    }
    // Fallback: home directory
    const homeCandidate = path.join(path.resolve(home), ".claude", "skills", name, "SKILL.md");
    if (fs.existsSync(homeCandidate))
        return homeCandidate;
    return null;
}
/**
 * Resolve skill SKILL.md using process.cwd() and os.homedir(), then read it.
 * Returns null on any error (missing file, permission error, etc.).
 */
export function readSkillMdFor(name) {
    try {
        const p = findSkillMd(name, process.cwd(), os.homedir());
        if (p === null)
            return null;
        return fs.readFileSync(p, "utf8");
    }
    catch {
        return null;
    }
}
