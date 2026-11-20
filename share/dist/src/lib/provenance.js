// packages/ef-share-plugin/src/lib/provenance.ts
//
// The disk-reading provenance collectors, as functions. `bin/extract-skills`
// and `bin/extract-plugins` print their result; `prepare` writes it beside the
// snapshot — for plugins, only the ones the session refers to
// (collectSessionPluginProvenance). One implementation, so the paths cannot drift.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractSkillProvenance, parseTranscriptSkills } from "./skills.js";
import { findSkillMdInCwds, findNearestLockfile } from "./skill-paths.js";
import { parseSkillsLock, provenanceFromLockEntry } from "./skill-lockfile.js";
import { extractAllPluginProvenance, installedPluginNames, pluginsReferencedBy } from "./plugins.js";
import { readJson } from "./transcript.js";
/** Publisher attribution for the session's loose skills (ADR-0021, ADR-0023). */
export function collectSkillProvenance(jsonl, home = os.homedir()) {
    const { commandNames, cwds } = parseTranscriptSkills(jsonl);
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
    return extractSkillProvenance(candidateNames, readSkillMd, lockfileFor);
}
const defaultPluginsRoot = () => process.env.EF_SHARE_PLUGINS_ROOT ?? path.join(os.homedir(), ".claude", "plugins");
function readRegistry(pluginsRoot) {
    const installed = readJson(path.join(pluginsRoot, "installed_plugins.json"));
    const marketplaces = readJson(path.join(pluginsRoot, "known_marketplaces.json"));
    const readManifest = (_marketplace, installLocation) => readJson(path.join(installLocation, ".claude-plugin", "marketplace.json"));
    return { installed, provenance: extractAllPluginProvenance(installed, marketplaces, readManifest) };
}
/** Source/origin of each installed plugin, from Claude Code's local registry (ADR-0022). */
export function collectPluginProvenance(pluginsRoot = defaultPluginsRoot()) {
    return readRegistry(pluginsRoot).provenance;
}
/**
 * What prepare uploads about plugins: the provenance of the installed plugins
 * this session refers to (pluginsReferencedBy over its published transcripts),
 * and — for the person — which installed plugins are not sent (unreferenced, or
 * with no address that can be uploaded).
 */
export function collectSessionPluginProvenance(transcripts, pluginsRoot = defaultPluginsRoot()) {
    const { installed, provenance } = readRegistry(pluginsRoot);
    const { sent } = pluginsReferencedBy(provenance.plugins, transcripts);
    const names = installedPluginNames(installed);
    const sentNames = new Set(sent.map((p) => p.name));
    return {
        payload: { ...provenance, plugins: sent },
        installed: names.length,
        sent: sent.map((p) => p.name),
        not_sent: names.filter((n) => !sentNames.has(n)),
    };
}
