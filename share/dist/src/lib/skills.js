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
 * For each skill name, read its SKILL.md (via injected callback), parse
 * frontmatter, collect only entries with a provenance signal, and wrap the
 * result with contract metadata.
 */
export function extractSkillProvenance(skillNames, readSkillMd) {
    const skills = [];
    for (const name of skillNames) {
        const md = readSkillMd(name);
        if (md === null)
            continue;
        const fm = parseFrontmatter(md);
        const signal = signalFromFrontmatter(name, fm);
        if (signal !== null)
            skills.push(signal);
    }
    return { skill_contract_version: "1.0.0", runtime: "claude-code", skills };
}
