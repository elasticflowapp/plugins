// packages/ef-share-plugin/src/lib/plugins.ts
//
// Pure functions that resolve a plugin's real source/origin from Claude Code's
// local registry. No external dependencies.
//
// Every address that leaves the machine goes through publicUrl: a marketplace
// added as `https://user:token@host/…` would otherwise be uploaded with its
// token (release review 2026-11-20, A-5). And only the plugins the session
// refers to are uploaded (pluginsReferencedBy), not the whole registry.
/**
 * `value` as it may be uploaded: an http(s) URL without its user name or
 * password, its query string or its fragment — a deploy token travels in any of
 * them (review round 2, A2-5), and the address of a repository needs none. A URL
 * that has none of these is returned byte for byte. Null for anything that
 * cannot be parsed, or that is not a web address (`git@host:…`, `ssh:`, `file:`):
 * the server keeps only http and https addresses, and a `file:` URL is a local path.
 */
export function publicUrl(value) {
    if (typeof value !== "string" || !value)
        return null;
    let u;
    try {
        u = new URL(value);
    }
    catch {
        return null;
    }
    if (u.protocol !== "https:" && u.protocol !== "http:")
        return null;
    if (!u.username && !u.password && !u.search && !u.hash)
        return value;
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    return u.toString();
}
/**
 * The plugins a session refers to: those whose name occurs, in any case, in one
 * of its published (sanitised) transcripts — in a tool name
 * (`mcp__plugin_<name>_…`), a skill (`<name>:<skill>`), `attributionPlugin`, the
 * skill and tool listings, a hook command under the plugin's directory. The
 * server keeps a plugin's entry only when the session lists its skills or MCP
 * tools, all of which name it, so this errs towards sending: a name that only
 * occurs inside another word is still sent.
 */
export function pluginsReferencedBy(plugins, transcripts) {
    const sent = [];
    const notSent = [];
    for (const p of plugins) {
        const name = new RegExp(p.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        if (transcripts.some((t) => name.test(t)))
            sent.push(p);
        else
            notSent.push(p.name);
    }
    return { sent, not_sent: notSent };
}
/** The distinct plugin names in Claude Code's `installed_plugins.json`. */
export function installedPluginNames(installed) {
    return [...new Set(Object.keys(installed?.plugins ?? {}).map((k) => k.split("@")[0]))];
}
export function orgFromUrl(url) {
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol))
            return null;
        if (!/(^|\.)(github\.com|gitlab\.com|bitbucket\.org)$/.test(u.hostname))
            return null;
        const seg = u.pathname.split("/").filter(Boolean);
        return seg.length >= 1 ? seg[0] : null;
    }
    catch {
        return null;
    }
}
function marketplaceRepoUrl(src) {
    if (!src)
        return undefined;
    if (typeof src.repo === "string")
        return `https://github.com/${src.repo}`;
    if (typeof src.url === "string")
        return src.url.replace(/\.git$/, "");
    return undefined;
}
export function resolvePluginSource(name, installed, marketplaces, readManifest) {
    const key = Object.keys(installed?.plugins ?? {}).find((k) => k.startsWith(name + "@"));
    if (!key)
        return null;
    const marketplace = key.slice(name.length + 1);
    const records = installed.plugins[key] ?? [];
    const rec = records.find((r) => r?.scope === "user") ?? records[0];
    const version = rec?.version && rec.version !== "unknown" ? String(rec.version) : undefined;
    const mkt = marketplaces?.[marketplace];
    if (!mkt)
        return null;
    const mktRepoUrl = marketplaceRepoUrl(mkt.source);
    const manifest = mkt.installLocation ? readManifest(marketplace, mkt.installLocation) : null;
    const entry = (manifest?.plugins ?? []).find((p) => p?.name === name);
    const src = entry?.source;
    let resolved, relative = true;
    if (src && typeof src === "object" && typeof src.url === "string") {
        resolved = src.url.replace(/\.git$/, "");
        relative = false;
    }
    else {
        resolved = mktRepoUrl;
    }
    // an address that cannot be uploaded as it is leaves the plugin out: the server needs one
    const source_url = publicUrl(resolved);
    if (!source_url)
        return null;
    const org = orgFromUrl(source_url);
    const author = typeof entry?.author?.name === "string" ? entry.author.name : undefined;
    const owner = typeof manifest?.owner?.name === "string" ? manifest.owner.name : undefined;
    const source_name = author ?? (relative ? owner : undefined) ?? org ?? undefined;
    if (!source_name)
        return null;
    const homepage = publicUrl(entry?.homepage);
    return { name, source_url, source_name, ...(homepage ? { homepage } : {}), ...(version ? { version } : {}) };
}
export function extractAllPluginProvenance(installed, marketplaces, readManifest) {
    const names = installedPluginNames(installed);
    const plugins = names.map((n) => resolvePluginSource(n, installed, marketplaces, readManifest)).filter(Boolean);
    return { plugin_contract_version: "1.0.0", runtime: "claude-code", plugins };
}
