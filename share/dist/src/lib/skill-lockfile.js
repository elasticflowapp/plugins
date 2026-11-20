// packages/ef-share-plugin/src/lib/skill-lockfile.ts
//
// Pure functions for reading a skill-manager lockfile (skills-lock.json) and
// deriving source-repository provenance from an entry. No filesystem access.
/**
 * Parse skills-lock.json content into a `name -> { source, sourceType }` map.
 * Tolerant: returns an empty map on any JSON/shape error, and skips entries
 * that lack a non-empty source or sourceType.
 */
export function parseSkillsLock(content) {
    const out = new Map();
    let data;
    try {
        data = JSON.parse(content);
    }
    catch {
        return out;
    }
    const skills = data?.["skills"];
    if (!skills || typeof skills !== "object")
        return out;
    for (const [name, raw] of Object.entries(skills)) {
        if (!raw || typeof raw !== "object")
            continue;
        const r = raw;
        const source = typeof r["source"] === "string" ? r["source"] : "";
        const sourceType = typeof r["sourceType"] === "string" ? r["sourceType"] : "";
        if (source && sourceType)
            out.set(name, { source, sourceType });
    }
    return out;
}
/** The characters GitHub allows in an owner or repository name. */
const GITHUB_NAME = /^[A-Za-z0-9_.-]+$/;
/**
 * Derive { publisher = repo, author = owner, source = URL } from a github
 * lockfile entry whose `source` is exactly "owner/repo". Returns null for a
 * non-github sourceType, a source that is not exactly two path segments, or a
 * segment GitHub would not accept — so nothing else (`user:token@host`, a
 * query) can ride into the URL that is uploaded (release review 2026-11-20, A-5).
 */
export function provenanceFromLockEntry(entry) {
    if (entry.sourceType !== "github")
        return null;
    const parts = entry.source.split("/").filter(Boolean);
    if (parts.length !== 2 || !parts.every((p) => GITHUB_NAME.test(p)))
        return null;
    const [owner, repo] = parts;
    return { publisher: repo, author: owner, source: `https://github.com/${owner}/${repo}` };
}
