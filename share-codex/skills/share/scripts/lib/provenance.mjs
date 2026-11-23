// Where the session's skills and plugins come from — the `skills` and `plugins`
// values of share_publish. Best effort: a session with nothing to attribute
// publishes fine without them.
//
// Skills: a Codex session loads a skill by reading its SKILL.md, so the snapshot
// already holds each loaded skill's frontmatter (publisher / homepage /
// repository / author / license / version).
//
// Plugins: a plugin skill lives under
//   $CODEX_HOME/plugins/cache/<marketplace>/<plugin>/<version>/…
// and Codex records each marketplace's source in config.toml
// ([marketplaces.<name>] source_type / source). That local registry is the
// authority for a plugin's origin; a marketplace added from a local folder has
// no verifiable source and is left out.

import fs from "node:fs"
import path from "node:path"
import { codexHome } from "./rollout.mjs"

const isObj = (v) => v !== null && typeof v === "object" && !Array.isArray(v)

/** Minimal YAML frontmatter reader: top-level scalars plus a one-level `metadata:` map. */
export function parseFrontmatter(md) {
  if (typeof md !== "string" || !md.startsWith("---")) return {}
  const rest = md.slice(3)
  const end = rest.indexOf("\n---")
  if (end === -1) return {}
  const result = {}
  const metadata = {}
  let inMetadata = false
  const unquote = (v) => v.trim().replace(/^["']|["']$/g, "")
  for (const raw of rest.slice(0, end).split("\n")) {
    const line = raw.trimEnd()
    if (!line) continue
    if (/^metadata:\s*$/.test(line)) {
      inMetadata = true
      continue
    }
    if (inMetadata && /^ {2}\S/.test(line)) {
      const m = /^ {2}([^:]+):\s*(.*)$/.exec(line)
      if (m) metadata[m[1].trim()] = unquote(m[2])
      continue
    }
    inMetadata = false
    const m = /^([^:\s][^:]*):\s*(.*)$/.exec(line)
    if (m) result[m[1].trim()] = unquote(m[2])
  }
  if (Object.keys(metadata).length > 0) result.metadata = metadata
  return result
}

/**
 * The Skill identifier ElasticFlow Share gives a SKILL.md path: a plugin skill
 * is `<plugin>:<skill>`, anything else is the bare skill name. Mirrors the
 * server's own naming of skills — a parity
 * test pins the two.
 */
export function skillNameFromPath(skillPath, content) {
  const segs = skillPath.slice(-4096).replace(/\/SKILL\.md$/i, "").split("/")
  const fmName = parseFrontmatter(content).name
  const bare = (typeof fmName === "string" && fmName) || segs[segs.length - 1] || "skill"
  if (bare.includes(":")) return bare
  // …/plugins/cache/<marketplace>/<plugin>/<version>/<at least the skill's folder>
  for (let i = 1; i + 4 < segs.length; i++) {
    if (segs[i] === "cache" && segs[i - 1] === "plugins" && segs[i + 2]) return `${segs[i + 2]}:${bare}`
  }
  return bare
}

/**
 * `{ marketplace, plugin, version, root }` for a file inside THIS Codex home's
 * plugin cache (`<cacheRoot>/<marketplace>/<plugin>/<version>/…`), else null. A
 * look-alike path elsewhere on disk is not an installed plugin and gets no
 * attribution.
 */
export function pluginOfPath(p, cacheRoot) {
  const root = String(cacheRoot ?? "").replace(/\/+$/, "")
  if (!root || typeof p !== "string" || !p.startsWith(root + "/") || p.split("/").includes("..")) return null
  const m = /^([^/]+)\/([^/]+)\/([^/]+)\/.+/.exec(p.slice(root.length + 1))
  return m ? { root: `${root}/${m[1]}/${m[2]}/${m[3]}`, marketplace: m[1], plugin: m[2], version: m[3] } : null
}

/** `<skill><name>…</name><path>…</path>…the file…</skill>` → `{ name, path, content }`, by index search. */
function parseSkillPart(text) {
  const t = text.trimStart()
  if (!t.startsWith("<skill>")) return null
  const close = t.lastIndexOf("</skill>")
  if (close === -1 || t.slice(close + "</skill>".length).trim() !== "") return null
  const inner = t.slice("<skill>".length, close)
  const tag = (name, from) => {
    const open = inner.indexOf(`<${name}>`, from)
    if (open === -1 || inner.slice(from, open).trim() !== "") return null
    const shut = inner.indexOf(`</${name}>`, open)
    return shut === -1 ? null : { value: inner.slice(open + name.length + 2, shut), end: shut + name.length + 3 }
  }
  const name = tag("name", 0)
  const skillPath = name && tag("path", name.end)
  if (!name || !skillPath) return null
  const content = inner.slice(skillPath.end).trim()
  return content ? { name: name.value.trim(), path: skillPath.value.trim(), content } : null
}

/**
 * The skills a session loaded, from a snapshot: `[{ name, path, content }]`. A
 * skill is loaded either by the agent reading its SKILL.md, or by the person
 * invoking it by name — Codex then adds the file as a `<skill>` user-role part.
 */
export function loadedSkills(jsonl) {
  const out = new Map()
  for (const line of jsonl.split("\n")) {
    const s = line.trim()
    if (!s) continue
    let rec
    try {
      rec = JSON.parse(s)
    } catch {
      continue
    }
    const p = isObj(rec) ? rec.payload : null
    if (isObj(p) && rec.type === "response_item" && p.type === "message" && p.role === "user" && Array.isArray(p.content)) {
      for (const c of p.content) {
        const part = isObj(c) && typeof c.text === "string" ? parseSkillPart(c.text) : null
        if (!part) continue
        const name = part.path ? skillNameFromPath(part.path, part.content) : part.name || "skill"
        out.set(name, { name, path: part.path, content: part.content })
      }
      continue
    }
    if (!isObj(p) || rec.type !== "event_msg" || p.type !== "item_completed" || !isObj(p.item)) continue
    const item = p.item
    if (item.type !== "CommandExecution" || item.exit_code !== 0) continue
    const parsed = Array.isArray(item.parsed_cmd) ? item.parsed_cmd : []
    if (parsed.length !== 1 || !isObj(parsed[0]) || parsed[0].type !== "read") continue
    const skillPath = typeof parsed[0].path === "string" ? parsed[0].path : ""
    const content = typeof item.aggregated_output === "string" ? item.aggregated_output : ""
    if (!/(?:^|\/)SKILL\.md$/i.test(skillPath) || !content.trim()) continue
    const name = skillNameFromPath(skillPath, content)
    out.set(name, { name, path: skillPath, content })
  }
  return [...out.values()]
}

function skillSignal(name, fm) {
  const meta = isObj(fm.metadata) ? fm.metadata : {}
  const s = (v) => (typeof v === "string" && v ? v : undefined)
  const entry = { name }
  const fields = {
    publisher: s(fm.publisher) ?? s(meta.publisher),
    homepage: s(fm.homepage),
    repository: s(fm.repository),
    source: s(fm.source),
    author: s(fm.author) ?? s(meta.author),
    license: s(fm.license),
    version: s(fm.version),
  }
  let has = false
  for (const [k, v] of Object.entries(fields)) {
    if (v) {
      entry[k] = v
      has = true
    }
  }
  return has ? entry : null
}

/** `[marketplaces.<name>]` tables of a Codex config.toml: name → { source_type, source }. */
export function parseMarketplaces(toml) {
  const out = {}
  let current = null
  let inMultiline = false
  for (const raw of String(toml ?? "").split("\n")) {
    const line = raw.trim()
    // A multi-line string can hold anything, a fake table header included.
    const fences = (line.match(/"""|'''/g) ?? []).length
    if (inMultiline) {
      if (fences % 2 === 1) inMultiline = false
      continue
    }
    if (fences % 2 === 1) {
      inMultiline = true
      continue
    }
    // `[table]` or `[[array of tables]]`, with or without a trailing comment
    const table = /^\[\[?([^\]]+)\]\]?\s*(?:#.*)?$/.exec(line)
    if (table) {
      const m = /^marketplaces\.(?:"([^"]+)"|([A-Za-z0-9_-]+))$/.exec(table[1].trim())
      current = m ? (out[m[1] ?? m[2]] = {}) : null
      continue
    }
    if (!current) continue
    const kv = /^(source_type|source)\s*=\s*"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/.exec(line)
    if (kv) current[kv[1]] = kv[2]
  }
  return out
}

/**
 * A repository web address from a marketplace's git source; null unless it is a
 * plain https address — no credentials, no query, no fragment (a token can sit
 * in any of them, and this value is published).
 */
export function repoUrl(source) {
  if (typeof source !== "string") return null
  const s = source.trim().replace(/\.git$/, "")
  try {
    const u = new URL(s)
    if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash) return null
    return s
  } catch {
    return null
  }
}

function orgOf(url) {
  try {
    return new URL(url).pathname.split("/").filter(Boolean)[0] ?? null
  } catch {
    return null
  }
}

function readJson(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"))
  } catch {
    return null
  }
}

function pluginManifest(root) {
  return readJson(path.join(root, ".codex-plugin", "plugin.json")) ?? readJson(path.join(root, "plugin.json"))
}

/**
 * The `skills` and `plugins` payloads for a snapshot. `deps` exists for tests:
 * `configToml` (text), `readManifest(root)` and `cacheRoot`.
 */
export function extractProvenance(jsonl, deps = {}) {
  // This plugin's own skill is the publishing flow, not the session's work: the
  // page does not count it, so neither its origin nor its plugin is sent — the
  // server would answer each with "not used in session".
  const skillsLoaded = loadedSkills(jsonl).filter((sk) => !(/^(?:ef-share:)?share$/.test(sk.name) && sk.content.includes("ef-share.mjs")))

  const skills = []
  for (const sk of skillsLoaded) {
    const signal = skillSignal(sk.name, parseFrontmatter(sk.content))
    if (signal) skills.push(signal)
  }

  let configToml = deps.configToml
  if (configToml === undefined) {
    try {
      configToml = fs.readFileSync(path.join(codexHome(), "config.toml"), "utf8")
    } catch {
      configToml = ""
    }
  }
  const marketplaces = parseMarketplaces(configToml)
  const readManifest = deps.readManifest ?? pluginManifest
  const cacheRoot = deps.cacheRoot ?? path.join(codexHome(), "plugins", "cache")

  const plugins = new Map()
  for (const sk of skillsLoaded) {
    const loc = pluginOfPath(sk.path, cacheRoot)
    if (!loc || plugins.has(loc.plugin)) continue
    const mkt = marketplaces[loc.marketplace]
    if (!mkt || mkt.source_type !== "git") continue
    const source_url = repoUrl(mkt.source)
    if (!source_url) continue
    const manifest = readManifest(loc.root)
    const author = isObj(manifest?.author) && typeof manifest.author.name === "string" ? manifest.author.name : null
    const source_name = author ?? orgOf(source_url)
    if (!source_name) continue
    const homepage = typeof manifest?.homepage === "string" ? manifest.homepage : null
    plugins.set(loc.plugin, {
      name: loc.plugin,
      source_url,
      source_name,
      ...(homepage ? { homepage } : {}),
      ...(loc.version && loc.version !== "local" ? { version: loc.version } : {}),
    })
  }

  return {
    skills: skills.length ? { skill_contract_version: "1.0.0", runtime: "codex", skills } : null,
    plugins: plugins.size ? { plugin_contract_version: "1.0.0", runtime: "codex", plugins: [...plugins.values()] } : null,
  }
}
