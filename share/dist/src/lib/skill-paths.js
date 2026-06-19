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
function walkAncestors(name, startDir) {
    let dir = path.resolve(startDir);
    while (true) {
        const candidate = path.join(dir, ".claude", "skills", name, "SKILL.md");
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // reached filesystem root
        dir = parent;
    }
    return null;
}
function homeSkillPath(name, home) {
    const candidate = path.join(path.resolve(home), ".claude", "skills", name, "SKILL.md");
    return fs.existsSync(candidate) ? candidate : null;
}
/**
 * Search for <name>/SKILL.md from `cwd` up the ancestors, then the home
 * user-scope skills dir. Returns the first existing path, or null.
 */
export function findSkillMd(name, cwd, home) {
    return walkAncestors(name, cwd) ?? homeSkillPath(name, home);
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
/**
 * Like findSkillMd but tries each cwd's ancestor chain first (project scope,
 * no home fallback mid-loop), so a project skill is preferred over a home one
 * across all cwds; the home user-scope dir is tried once after all cwds are
 * exhausted (which also handles an empty `cwds`).
 */
export function findSkillMdInCwds(name, cwds, home) {
    for (const cwd of cwds) {
        const hit = walkAncestors(name, cwd);
        if (hit)
            return hit;
    }
    return homeSkillPath(name, home);
}
/**
 * Walk up from `startDir` to the filesystem root, returning the path of the
 * nearest `skills-lock.json`, or null if none exists on the ancestry. This is
 * the scope-correct, co-located governing lockfile for the skill at startDir.
 */
export function findNearestLockfile(startDir) {
    let dir = path.resolve(startDir);
    while (true) {
        const candidate = path.join(dir, "skills-lock.json");
        if (fs.existsSync(candidate))
            return candidate;
        const parent = path.dirname(dir);
        if (parent === dir)
            break; // filesystem root
        dir = parent;
    }
    return null;
}
