import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSkillProvenance, parseTranscriptSkills } from "../src/lib/skills.js";
import { findSkillMdInCwds, findNearestLockfile } from "../src/lib/skill-paths.js";
import { parseSkillsLock, provenanceFromLockEntry } from "../src/lib/skill-lockfile.js";
const transcriptPath = process.argv[2];
if (!transcriptPath) {
    console.error("usage: extract-skills <transcript.jsonl>");
    process.exit(2);
}
const jsonl = fs.readFileSync(transcriptPath, "utf-8");
const { commandNames, cwds } = parseTranscriptSkills(jsonl);
const home = os.homedir();
// Enumeration: union of slash-invoked skills and skills listed in any
// discovered lockfile (project, via the transcript cwd walk-up; user, via
// home), so auto-activated skills (no <command-name> tag) are covered too.
const lockfilePaths = new Set();
for (const start of [...cwds, path.join(home, ".claude", "skills"), home]) {
    const lf = findNearestLockfile(start);
    if (lf)
        lockfilePaths.add(lf);
}
const lockfileNames = new Set();
for (const lf of lockfilePaths) {
    try {
        for (const n of parseSkillsLock(fs.readFileSync(lf, "utf8")).keys())
            lockfileNames.add(n);
    }
    catch {
        /* best-effort: a bad lockfile contributes no names */
    }
}
const candidateNames = [...new Set([...commandNames, ...lockfileNames])];
function readSkillMd(name) {
    try {
        const p = findSkillMdInCwds(name, cwds, home);
        return p ? fs.readFileSync(p, "utf8") : null;
    }
    catch {
        return null;
    }
}
// Per-skill, scope-correct provenance: find the skill on disk, then walk up
// from ITS directory to the nearest skills-lock.json (co-location by
// construction), look it up there, and derive the source repo.
function lockfileFor(name) {
    try {
        const p = findSkillMdInCwds(name, cwds, home);
        if (!p)
            return null;
        const lf = findNearestLockfile(path.dirname(p));
        if (!lf)
            return null;
        const entry = parseSkillsLock(fs.readFileSync(lf, "utf8")).get(name);
        return entry ? provenanceFromLockEntry(entry) : null;
    }
    catch {
        return null;
    }
}
process.stdout.write(JSON.stringify(extractSkillProvenance(candidateNames, readSkillMd, lockfileFor)));
