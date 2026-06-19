// packages/ef-share-plugin/src/lib/skills.ts
//
// Pure functions that read a skill's SKILL.md frontmatter and emit
// publisher-provenance for the share payload. No external YAML dependency.
/**
 * Minimal YAML frontmatter parser — top-level scalars plus a one-level
 * `metadata:` map. Handles only the subset we care about; no external dep.
 */
export function parseFrontmatter(md) {
    // Must start with ---
    if (!md.startsWith("---"))
        return {};
    const rest = md.slice(3);
    const end = rest.indexOf("\n---");
    if (end === -1)
        return {};
    const block = rest.slice(0, end);
    const result = {};
    let inMetadata = false;
    const metadata = {};
    for (const raw of block.split("\n")) {
        const line = raw.trimEnd();
        if (!line)
            continue;
        // Detect `metadata:` section header (no value on same line)
        if (/^metadata:\s*$/.test(line)) {
            inMetadata = true;
            continue;
        }
        // Indented key: value inside metadata block
        if (inMetadata && /^  \S/.test(line)) {
            const m = /^  ([^:]+):\s*(.*)$/.exec(line);
            if (m)
                metadata[m[1].trim()] = m[2].trim();
            continue;
        }
        // Any non-indented key exits the metadata block
        inMetadata = false;
        const m = /^([^:]+):\s*(.*)$/.exec(line);
        if (m)
            result[m[1].trim()] = m[2].trim();
    }
    if (Object.keys(metadata).length > 0)
        result["metadata"] = metadata;
    return result;
}
/**
 * Map a parsed frontmatter object to a SkillProvenance signal.
 * Returns null when no provenance field is present.
 */
export function signalFromFrontmatter(name, fm) {
    const meta = (fm["metadata"] && typeof fm["metadata"] === "object")
        ? fm["metadata"]
        : {};
    const str = (v) => typeof v === "string" && v ? v : undefined;
    const publisher = str(fm["publisher"]) ?? str(meta["publisher"]);
    const homepage = str(fm["homepage"]);
    const repository = str(fm["repository"]);
    const source = str(fm["source"]);
    const author = str(fm["author"]) ?? str(meta["author"]);
    const license = str(fm["license"]);
    const version = str(fm["version"]);
    const hasSignal = publisher || homepage || repository || source || author || license || version;
    if (!hasSignal)
        return null;
    const entry = { name };
    if (publisher)
        entry.publisher = publisher;
    if (homepage)
        entry.homepage = homepage;
    if (repository)
        entry.repository = repository;
    if (source)
        entry.source = source;
    if (author)
        entry.author = author;
    if (license)
        entry.license = license;
    if (version)
        entry.version = version;
    return entry;
}
/**
 * Merge a frontmatter signal with lockfile provenance. The lockfile is the
 * authoritative install record, so it wins for publisher/author/source; the
 * frontmatter keeps homepage/repository/license/version. Returns null when
 * neither contributes a field.
 */
export function mergeSignals(name, fm, lock) {
    if (!fm && !lock)
        return null;
    const entry = { name };
    const publisher = lock?.publisher ?? fm?.publisher;
    const author = lock?.author ?? fm?.author;
    const source = lock?.source ?? fm?.source;
    if (publisher)
        entry.publisher = publisher;
    if (author)
        entry.author = author;
    if (source)
        entry.source = source;
    if (fm?.homepage)
        entry.homepage = fm.homepage;
    if (fm?.repository)
        entry.repository = fm.repository;
    if (fm?.license)
        entry.license = fm.license;
    if (fm?.version)
        entry.version = fm.version;
    // fm and lock are each non-empty by construction (signalFromFrontmatter returns
    // null for an empty frontmatter; a LockProvenance always carries publisher/author/source),
    // so this guard is belt-and-suspenders, not live logic.
    const has = entry.publisher || entry.author || entry.source || entry.homepage || entry.repository || entry.license || entry.version;
    return has ? entry : null;
}
/**
 * For each skill name, combine its SKILL.md frontmatter signal (via the
 * injected reader) with lockfile provenance (via the injected lookup), keeping
 * only entries that carry at least one provenance field.
 */
export function extractSkillProvenance(skillNames, readSkillMd, lockfileFor = () => null) {
    const skills = [];
    for (const name of skillNames) {
        const md = readSkillMd(name);
        const fm = md !== null ? signalFromFrontmatter(name, parseFrontmatter(md)) : null;
        const merged = mergeSignals(name, fm, lockfileFor(name));
        if (merged !== null)
            skills.push(merged);
    }
    return { skill_contract_version: "1.0.0", runtime: "claude-code", skills };
}
const BUILTIN_COMMANDS = new Set([
    "share", "clear", "help", "exit", "quit", "config", "login", "logout",
    "init", "doctor", "status", "review", "bug", "compact", "cost", "memory",
    "vim", "editor", "model", "settings", "add-dir", "ide",
]);
function isBuiltin(name) {
    if (name.includes(":"))
        return false; // namespaced -> always an external skill
    return BUILTIN_COMMANDS.has(name.toLowerCase());
}
const CMD_RE = /<command-name>([^<]+)<\/command-name>/g;
/**
 * Parse a session transcript (jsonl) into the set of slash-invoked skill names
 * (excluding built-in Claude Code commands) and the distinct working dirs the
 * session recorded. Tolerant of malformed lines.
 */
export function parseTranscriptSkills(jsonl) {
    const commandNames = new Set();
    const cwds = new Set();
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
        const cwd = rec["cwd"];
        if (typeof cwd === "string" && cwd)
            cwds.add(cwd);
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
                commandNames.add(name);
        }
    }
    return { commandNames: [...commandNames], cwds: [...cwds] };
}
