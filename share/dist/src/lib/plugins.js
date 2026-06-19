// packages/ef-share-plugin/src/lib/plugins.ts
//
// Pure functions that resolve a plugin's real source/origin from Claude Code's
// local registry. No external dependencies.
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
    let source_url, org = null, relative = true;
    if (src && typeof src === "object" && typeof src.url === "string") {
        const resolved = src.url.replace(/\.git$/, "");
        source_url = resolved;
        org = orgFromUrl(resolved);
        relative = false;
    }
    else {
        source_url = mktRepoUrl;
        org = source_url != null ? orgFromUrl(source_url) : null;
    }
    if (!source_url)
        return null;
    const author = typeof entry?.author?.name === "string" ? entry.author.name : undefined;
    const owner = typeof manifest?.owner?.name === "string" ? manifest.owner.name : undefined;
    const source_name = author ?? (relative ? owner : undefined) ?? org ?? undefined;
    if (!source_name)
        return null;
    const homepage = typeof entry?.homepage === "string" ? entry.homepage : undefined;
    return { name, source_url, source_name, ...(homepage ? { homepage } : {}), ...(version ? { version } : {}) };
}
export function extractAllPluginProvenance(installed, marketplaces, readManifest) {
    const names = [...new Set(Object.keys(installed?.plugins ?? {}).map((k) => k.split("@")[0]))];
    const plugins = names.map((n) => resolvePluginSource(n, installed, marketplaces, readManifest)).filter(Boolean);
    return { plugin_contract_version: "1.0.0", runtime: "claude-code", plugins };
}
