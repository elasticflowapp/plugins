// packages/ef-share-plugin/src/lib/sanitize.ts
//
// Data minimisation for a transcript that is about to leave the machine.
//
// A current Claude Code transcript (measured 2026-11-16 on 2.1.281–2.1.325) is no
// longer just the conversation. It also records what Claude Code sent to the model
// and what it knows about the person:
//
//   api-request / api-request-shape / api-request-blob   the wire requests
//   attachment prompt_snapshot                           the system prompt
//   attachment instructions                              CLAUDE.md and memory files
//   attachment session_context                           user email, git status
//   attachment credential_org / record bridge-session    account and org ids
//   system:bridge_status                                 the remote-control URL
//
// Over 70 local sessions these were 31% of the main transcript's bytes. None of
// them is something a reader of a shared session needs, and the server drops
// every one of them at ingest. So they never leave the machine.
//
// The filter is an ALLOWLIST at three levels, because the format is internal to
// Claude Code and changes between releases — something new must be looked at
// before it is published, never published because nobody had heard of it:
//
//   1. the record KIND   — top-level type, `system` subtype, attachment type
//   2. the record FIELDS — the envelope keys of a kept record
//   3. inside a hook attachment — only the fields of the firing that are read
//      (its name, event, command, exit code, duration and what it injected);
//      `stderr` and anything else is left behind
//
// Whatever is left behind is counted by name (`dropped_by_kind`,
// `fields_dropped`), so the publisher can be shown it.
//
// Two things are taken out of the CONTENT of kept records, because Claude Code
// repeats there what the dropped records hold (release review 2026-11-20):
//
//   - an instruction file the harness copied into a `user` record it wrote
//     itself (`isMeta`). Claude Code 2.1.309+ (desktop app) writes such a record
//     when the working directory changes: a `<system-reminder>` saying so,
//     followed by "Contents of <path>/CLAUDE.md (project instructions, …):" and
//     the whole file. From that line to the end of its reminder — or of the text,
//     when the file follows the reminder as it does today — is replaced by one
//     line, INSTRUCTION_MARKER, and counted (`instruction_blocks_withheld`). The
//     record and what precedes the block stay. A record the person or the model
//     wrote is never touched, even when it quotes such a block.
//   - the account's identifiers. They are read from the records that are left
//     behind (`credential_org.organizationUuid`, `bridge-session`
//     `ownerOrganizationUuid` / `ownerAccountUuid`, the address in
//     `session_context.context.userEmail`, and any field so named at the top of
//     a dropped record or in its attachment — never inside a dropped copy of the
//     conversation, whose tool inputs name other people) and from the desktop
//     app's directory layout, which names both ids by position
//     (`…/Claude/scratch-workspaces/<account>/<organisation>/…`,
//     `…/skills-plugin/<organisation>/<account>/…`). Every occurrence, in any
//     case, in a kept record — a desktop-app `cwd`, a skill's base directory, a
//     tool input, the conversation's text — becomes `[organisation-id]`,
//     `[account-id]` or `[account-email]`, counted per kind
//     (`account_identifiers_replaced`). This takes two passes
//     (minimiseTranscript, finishTranscript), so that prepare can collect the
//     ids from the main transcript and every sub-agent transcript before any of
//     them is written.
//
// WHAT THIS DOES NOT DO. Otherwise a kept record keeps its content. In
// particular the context a hook injected into the session
// (`hook_additional_context.content`, `hook_success.stdout`) is published — it
// is what the Automations panel shows a reader. If one of your hooks injects
// memory notes or instruction text, that text is part of the published
// session; prepare reports how many injections there are, and the server's
// redaction scan covers them. Likewise an e-mail address or a path the person
// or the model wrote into the conversation is published, unless it is one of
// the account's own identifiers found above. A kept attachment (`invoked_skills`,
// `skill_listing`, `deferred_tools_delta` …) goes out whole, minus those.
//
// Kept records are re-serialised. The values of `uuid`, `parentUuid`,
// `sessionId`, `agentId`, `timestamp` and the request, message and tool-use ids
// are never edited, so chapter, automation and hidden-record refs resolve
// against the uploaded file exactly as they do against the original. `message`
// is edited only where described above: thinking signatures are removed, an
// isMeta record loses its instruction blocks, the account's identifiers are
// replaced. The BYTES of a line may differ from the original's (JSON escapes,
// number formatting).
/**
 * Top-level record types that carry the session a reader sees. `cost-state`
 * (what the session cost its author) is deliberately not one of them.
 */
const KEEP_TYPES = new Set([
    "user",
    "assistant",
    "system",
    "permission-mode",
    "mode",
    "ai-title",
    "custom-title",
    "summary",
]);
/**
 * `system` subtypes that are part of the session (measured on 320 local
 * transcripts, 2026-11-16). `bridge_status` — the remote-control URL — and any
 * subtype not listed here stay on the machine.
 */
const KEEP_SYSTEM_SUBTYPES = new Set([
    "compact_boundary",
    "microcompact_boundary",
    "stop_hook_summary",
    "api_error",
    "turn_duration",
    "scheduled_task_fire",
    "local_command",
    "away_summary",
    "informational",
    "agents_killed",
]);
/** Attachment types the server reads, or that explain how the session ran. */
const KEEP_ATTACHMENTS = new Set([
    "invoked_skills",
    "skill_listing",
    "dynamic_skill",
    "deferred_tools_delta",
    "goal_status",
    "ultra_effort_enter",
    "task_status",
    "structured_output",
    "model",
]);
/**
 * Envelope fields of a kept record that are published: what the server reads,
 * the ids that link records, and the few scalars that say how a turn was run.
 * Every other key — the queue, the classifier, the wire, the retry state —
 * stays behind and is counted in `fields_dropped`.
 */
const KEEP_FIELDS = new Set([
    // identity and linkage
    "type", "subtype", "uuid", "parentUuid", "logicalParentUuid", "timestamp",
    "sessionId", "session_id", "agentId", "slug", "promptId", "requestId",
    "sourceToolAssistantUUID", "sourceToolUseID", "toolUseID", "leafUuid",
    // where and how it ran
    "version", "entrypoint", "cwd", "gitBranch", "userType",
    "isSidechain", "isMeta", "isCompactSummary", "isVisibleInTranscriptOnly",
    "turnOrigin", "origin", "promptSource", "scheduledTaskId", "scheduledFireId",
    "permissionMode", "mode", "effort", "perTurnEffort", "requestedModel", "thinkingDurationMs",
    "attributionAgent", "attributionSkill", "attributionPlugin", "attributionMcpServer", "attributionMcpTool",
    // content
    "message", "attachment", "content", "level", "summary", "aiTitle", "customTitle",
    "toolUseResult", "compactMetadata", "commandRun", "commandOutcome",
    // what a system record reports
    "hookCount", "hookInfos", "hookErrors", "preventedContinuation", "stopReason", "hasOutput",
    "durationMs", "messageCount", "taskId", "pendingBackgroundAgentCount",
    "isApiErrorMessage", "apiErrorStatus", "toolDenialKind", "interruptedMessageId",
]);
/**
 * `toolUseResult` duplicates the tool's output in a structured form, and for an
 * Edit it holds the WHOLE original file, not the diff the conversation shows.
 * Only the sub-agent summary is something the server cannot get elsewhere.
 */
const AGENT_RESULT_FIELDS = [
    "status",
    "agentId",
    "agentType",
    "isAsync",
    "description",
    "resolvedModel",
    "totalDurationMs",
    "totalTokens",
    "totalToolUseCount",
    "usage",
    "toolStats",
];
/**
 * Fields of a hook firing that are published (measured on 13,531 `hook_success`
 * records, 2026-11-16). What the hook put into the session is `content` for a
 * `hook_additional_context` and `stdout` for the others; a `hook_success` also
 * carries a `content` string that nothing reads (empty in all but 2 of those
 * records) — it stays behind with `stderr`.
 */
const HOOK_FIELDS = new Set(["type", "hookName", "hookEvent", "toolUseID", "command", "exitCode", "durationMs", "stdout"]);
const HOOK_CONTEXT_FIELDS = new Set(["type", "hookName", "hookEvent", "toolUseID", "content"]);
export const ACCOUNT_IDENTIFIER_KINDS = ["organisation_id", "account_id", "account_email"];
/** What an identifier of the account becomes in a published record. */
export const ACCOUNT_PLACEHOLDERS = {
    organisation_id: "[organisation-id]",
    account_id: "[account-id]",
    account_email: "[account-email]",
};
export const emptyAccountIdentifiers = () => ({ organisation_id: [], account_id: [], account_email: [] });
export const zeroAccountCounts = () => ({ organisation_id: 0, account_id: 0, account_email: 0 });
/** The one line an instruction block the harness wrote into an isMeta record is replaced with. */
export const INSTRUCTION_MARKER = "[instruction file contents left on this machine]";
/** `type[:subtype][:att=<attachment type>]` — the unit the publisher is shown. */
export function recordKind(rec) {
    const t = typeof rec["type"] === "string" ? rec["type"] : "?";
    const sub = typeof rec["subtype"] === "string" ? `:${rec["subtype"]}` : "";
    const att = rec["attachment"];
    const attType = att && typeof att === "object" && typeof att["type"] === "string"
        ? `:att=${att["type"]}`
        : "";
    return `${t}${sub}${attType}`;
}
function attachmentType(rec) {
    const att = rec["attachment"];
    if (!att || typeof att !== "object")
        return null;
    const at = att["type"];
    return typeof at === "string" ? at : null;
}
export function isKeptRecord(rec) {
    const t = rec["type"];
    if (t === "attachment") {
        const at = attachmentType(rec);
        if (at === null)
            return false;
        // Every hook_* attachment is a firing the Automations panel anchors on.
        return at.startsWith("hook_") || KEEP_ATTACHMENTS.has(at);
    }
    if (t === "system")
        return typeof rec["subtype"] === "string" && KEEP_SYSTEM_SUBTYPES.has(rec["subtype"]);
    return typeof t === "string" && KEEP_TYPES.has(t);
}
function slimToolUseResult(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return undefined;
    const v = value;
    const isAgentResult = typeof v["agentId"] === "string" || typeof v["totalDurationMs"] === "number";
    if (!isAgentResult)
        return undefined;
    const out = {};
    for (const k of AGENT_RESULT_FIELDS)
        if (v[k] !== undefined)
            out[k] = v[k];
    return out;
}
/** Thinking signatures are opaque provider blobs — kilobytes each, nothing to read. */
function stripThinkingSignatures(message) {
    if (!message || typeof message !== "object")
        return;
    const content = message["content"];
    if (!Array.isArray(content))
        return;
    for (const part of content) {
        if (part && typeof part === "object" && part["type"] === "thinking" && "signature" in part) {
            delete part["signature"];
        }
    }
}
/** True when a hook attachment carries context the hook put into the session. */
function hasInjection(att) {
    if (att["type"] === "hook_additional_context")
        return Array.isArray(att["content"]) && att["content"].length > 0;
    const stdout = att["stdout"];
    return typeof stdout === "string" && stdout.includes("additionalContext");
}
// ─── instruction files the harness copied into a record of its own ──────────
const OPEN_TAG = "<system-reminder>";
const CLOSE_TAG = "</system-reminder>";
/** The line Claude Code writes before each file it loaded: "Contents of <path> (<description>):". */
const CONTENTS_LINE = /^Contents of .+ \((.+)\):$/;
/**
 * The descriptions it gives instruction and memory files (2.1.309–2.1.325):
 * "project instructions, checked into the codebase", "user's private global
 * instructions for all projects", "user's auto-memory, persists across conversations".
 */
const INSTRUCTION_FILE = /instruction|memor/i;
/** The context headings it prepends in the same style. */
const CONTEXT_HEADING = /^# (?:claudeMd|userEmail)$/;
/** How the harness opens the message it writes when the working directory changes (2.1.309–2.1.325). */
const DIRECTORY_CHANGED = "The session's working directory has changed";
const occurrences = (s, sub) => s.split(sub).length - 1;
/**
 * `text` without the instruction-file blocks the harness wrote into it.
 *
 * A block starts at a `Contents of <path> (<instructions or memory …>):` line,
 * at a `# claudeMd` / `# userEmail` heading, or — inside a `<system-reminder>` —
 * at any `Contents of … (…):` line. Inside a reminder it ends at the LAST
 * closing tag of the text, so that a closing tag quoted inside the file cannot
 * end the cut early; the closing tag itself stays. Outside one (Claude Code
 * 2.1.309+ writes the file after the reminder) it ends with the text. Each
 * block becomes one INSTRUCTION_MARKER line; a text without one is returned as is.
 *
 * Two shapes nobody has seen yet are read on the safe side (review round 2, A2-3):
 * a closing tag ends a block only where it STARTS a line, as the harness writes its
 * own — one quoted in the middle of a line of the file does not, so a block in a
 * reminder that is never closed runs to the end of the text; and in a message
 * about a working-directory change every `Contents of … (…):` line starts a
 * block, whatever the description says ("project rules", a wording to come) —
 * every file the harness lists there is one it loaded as instructions.
 */
export function withholdInstructionBlocks(text) {
    const lines = text.split("\n");
    const aboutDirectoryChange = text.includes(DIRECTORY_CHANGED);
    const out = [];
    let open = 0; // reminders opened and not closed before the current line
    let cuts = 0;
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        // the cheap test first: on a long line that is not one, the pattern would backtrack
        const contents = line.startsWith("Contents of ") && line.endsWith("):") ? CONTENTS_LINE.exec(line) : null;
        const starts = CONTEXT_HEADING.test(line) || (contents !== null && (open > 0 || aboutDirectoryChange || INSTRUCTION_FILE.test(contents[1])));
        if (!starts) {
            out.push(lines[i]);
            open = Math.max(0, open + occurrences(lines[i], OPEN_TAG) - occurrences(lines[i], CLOSE_TAG));
            continue;
        }
        cuts++;
        out.push(INSTRUCTION_MARKER);
        let end = -1;
        if (open > 0)
            for (let j = lines.length - 1; j > i; j--)
                if (lines[j].trimStart().startsWith(CLOSE_TAG)) {
                    end = j;
                    break;
                }
        if (end < 0)
            break; // not inside a reminder, or one that is never closed: the rest of the text is the file
        const tail = lines[end].slice(lines[end].lastIndexOf(CLOSE_TAG));
        out.push(tail);
        open = occurrences(tail, OPEN_TAG); // the tail's closing tag ends the reminder the block was in
        i = end;
    }
    return cuts === 0 ? { text, cuts } : { text: out.join("\n"), cuts };
}
/**
 * Cuts the instruction blocks out of a `user` record the harness wrote itself
 * (`isMeta`) — its string content or the `text` parts of its content. Any other
 * record, and any other part (a tool result), is the conversation and is left
 * as it is. Returns how many blocks were cut.
 */
function withholdInstructionsInRecord(rec) {
    if (rec["type"] !== "user" || rec["isMeta"] !== true)
        return 0;
    const message = rec["message"];
    if (!message || typeof message !== "object")
        return 0;
    const m = message;
    if (typeof m["content"] === "string") {
        const r = withholdInstructionBlocks(m["content"]);
        m["content"] = r.text;
        return r.cuts;
    }
    let cuts = 0;
    if (Array.isArray(m["content"])) {
        for (const part of m["content"]) {
            if (!part || typeof part !== "object" || part["type"] !== "text" || typeof part["text"] !== "string")
                continue;
            const r = withholdInstructionBlocks(part["text"]);
            part["text"] = r.text;
            cuts += r.cuts;
        }
    }
    return cuts;
}
// ─── the account's identifiers ───────────────────────────────────────────────
/**
 * Field names under which Claude Code keeps the account's ids in records it
 * never publishes (measured 2026-11-20 on 2.1.281–2.1.325):
 * `credential_org.organizationUuid`, `bridge-session.ownerOrganizationUuid` /
 * `.ownerAccountUuid`, `artifact-autoreact-ledger.accountUuid`,
 * `history-suppression.vetoedAgainstAccountUuid`, and the address inside
 * `session_context.context.userEmail` ("The user's email address is … .").
 */
const ID_FIELDS = [
    ["organisation_id", /(?:organi[sz]ation|^org)_?(?:uuid|id)$/i],
    ["account_id", /account_?(?:uuid|id)$/i],
];
const EMAIL_FIELD = /e-?mail(?:_?address)?$/i;
const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;
/** A shorter value is not looked for: it would be found by accident. */
const MIN_IDENTIFIER_LENGTH = 8;
/**
 * The desktop app names both ids by position in its own directories (measured
 * 2026-11-20 over 400 sessions, two accounts): `…/Claude/scratch-workspaces/
 * <account>/<organisation>/…` — also hyphen-encoded, as in the project and
 * scratchpad directory names — and `…/local-agent-mode-sessions/skills-plugin/
 * <organisation>/<account>/…`. A session that has no record naming the account
 * (2.1.309: no `bridge-session`) still publishes these paths in every `cwd`.
 */
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
/**
 * What may separate two parts of a path as it stands in a transcript line: `/`; `-`
 * (Claude Code names a project's folder after its path, every separator a hyphen);
 * `\` once, or doubled and redoubled by JSON; `\/`; a percent-encoded slash or
 * backslash (review round 3, R3-5). The layouts are read in either letter case.
 */
const SEP = String.raw `(?:\\{1,4}/?|/|-|%2[Ff]|%5[Cc])`;
const DESKTOP_LAYOUTS = [
    { marker: "scratch-workspaces", re: new RegExp(`scratch-workspaces${SEP}(${UUID})${SEP}(${UUID})`, "gi"), kinds: ["account_id", "organisation_id"] },
    { marker: "skills-plugin", re: new RegExp(`skills-plugin${SEP}(${UUID})${SEP}(${UUID})`, "gi"), kinds: ["organisation_id", "account_id"] },
    // skills synced to the account: ~/.claude/skills/synced/<organisation>_<account>/<skill> — in 2 of 214
    // measured sessions the only place that named the account (review round 2, A2-1)
    { marker: "synced", re: new RegExp(`synced${SEP}(${UUID})[_-](${UUID})`, "gi"), kinds: ["organisation_id", "account_id"] },
    // where the desktop app keeps a session: …/Claude/local-agent-mode-sessions/<account>/<organisation>/local_<id>/…
    // — the cwd of every record; 6 of 9 measured desktop sessions had no record naming the ids (round 3, R3-1)
    { marker: "local-agent-mode-sessions", re: new RegExp(`local-agent-mode-sessions${SEP}(${UUID})${SEP}(${UUID})`, "gi"), kinds: ["account_id", "organisation_id"] },
];
const UUID_ONLY = new RegExp(`^${UUID}$`, "i");
const EMAIL_ONLY = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
/**
 * A value is looked for everywhere in the session, so it must be an identifier and
 * nothing else: a uuid for an id, an address for an e-mail. A field merely NAMED
 * like one can hold a word ("workspace", "anonymous"), and that word would then be
 * replaced wherever the conversation uses it (review round 2, A2-4). Every value
 * Claude Code was measured to record has one of these two shapes.
 */
function takeIdentifier(into, kind, raw) {
    const shaped = kind === "account_email" ? EMAIL_ONLY.test(raw) : UUID_ONLY.test(raw);
    const value = kind === "account_email" ? raw : raw.toLowerCase(); // one spelling per id; it is looked for in any case
    if (shaped && value.length >= MIN_IDENTIFIER_LENGTH && !into[kind].includes(value))
        into[kind].push(value);
}
/** The ids the desktop app's directory layout names, anywhere in `text`. */
export function collectIdentifiersFromPaths(text, into) {
    scanDesktopLayouts(text, into);
}
/**
 * The ids an object names by field — for Claude Code's own record of the account
 * it is signed in to (`oauthAccount` in its config file: `accountUuid`,
 * `organizationUuid`, `emailAddress`; key names measured 2026-11-20 on 2.1.281).
 * That record is the one source that does not depend on what a session happened to
 * write down: a terminal session records none of the three, and each new folder
 * layout would otherwise be one more pattern to learn (review round 3, R3-1, A2-2).
 * Anything that is not a plain object is ignored.
 */
export function takeAccountFields(o, into) {
    if (o && typeof o === "object" && !Array.isArray(o))
        takeFields(o, into);
}
function scanDesktopLayouts(text, into) {
    for (const layout of DESKTOP_LAYOUTS) {
        if (!text.includes(layout.marker))
            continue;
        for (const m of text.matchAll(layout.re)) {
            takeIdentifier(into, layout.kinds[0], m[1]);
            takeIdentifier(into, layout.kinds[1], m[2]);
        }
    }
}
function takeFields(o, into) {
    for (const [k, v] of Object.entries(o)) {
        if (typeof v !== "string")
            continue;
        for (const [kind, field] of ID_FIELDS)
            if (field.test(k) && /^\S+$/.test(v))
                takeIdentifier(into, kind, v);
        if (EMAIL_FIELD.test(k))
            for (const m of v.matchAll(EMAIL))
                takeIdentifier(into, "account_email", m[0]);
    }
}
/**
 * The ids a record that is left behind names by field — where Claude Code puts
 * its own: the record's top level (`bridge-session`, `artifact-autoreact-ledger`),
 * its attachment and the attachment's objects (`credential_org`,
 * `session_context.context`). Never deeper: a dropped wire copy of the
 * conversation (`api-request-blob`) holds tool inputs whose `assignee_email` or
 * `orgId` belong to other people and other services.
 */
function visitDroppedRecord(rec, into) {
    takeFields(rec, into);
    const att = rec["attachment"];
    if (!att || typeof att !== "object" || Array.isArray(att))
        return;
    takeFields(att, into);
    for (const v of Object.values(att))
        if (v && typeof v === "object" && !Array.isArray(v))
            takeFields(v, into);
}
/**
 * The account's identifiers. By field name, only from the records of `jsonl`
 * that are LEFT BEHIND (a published record is never such a source: its e-mail
 * addresses are the conversation's); by position, from the desktop app's
 * directory layout wherever a record names one. Adds to `into`.
 */
export function collectAccountIdentifiers(jsonl, into = emptyAccountIdentifiers()) {
    minimiseTranscript(jsonl, into);
    return into;
}
/** Envelope fields that link records. Their values are never edited, whatever they hold. */
const LINKAGE_FIELDS = new Set([
    "uuid", "parentUuid", "logicalParentUuid", "leafUuid", "sessionId", "session_id", "agentId", "timestamp",
    "promptId", "requestId", "sourceToolAssistantUUID", "sourceToolUseID", "toolUseID",
]);
/** True for the path (from the record's top) of a value that links records: the envelope ids, the message id, tool-use ids. */
function isLinkage(at) {
    if (at.length === 1)
        return LINKAGE_FIELDS.has(at[0]);
    if (at.length === 2)
        return (at[0] === "message" && at[1] === "id") || (at[0] === "attachment" && at[1] === "toolUseID") || (at[0] === "toolUseResult" && at[1] === "agentId");
    return at.length === 4 && at[0] === "message" && at[1] === "content" && (at[3] === "id" || at[3] === "tool_use_id");
}
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function makeReplacer(ids) {
    const all = ACCOUNT_IDENTIFIER_KINDS.flatMap((kind) => ids[kind].filter((v) => v.length >= MIN_IDENTIFIER_LENGTH).map((value) => ({ kind, value })));
    if (all.length === 0)
        return null;
    all.sort((a, b) => b.value.length - a.value.length); // the longer value wins where one contains another
    const alternatives = all.map((e) => escapeRegExp(e.value)).join("|");
    return {
        inJson: new RegExp(all.map((e) => escapeRegExp(JSON.stringify(e.value).slice(1, -1))).join("|"), "i"),
        once: new RegExp(alternatives, "i"),
        every: new RegExp(alternatives, "gi"),
        // matched case-insensitively: an address or a uuid written in other case is still the account's
        kindOf: new Map(all.map((e) => [e.value.toLowerCase(), e.kind])),
    };
}
function replaceInString(s, r, counts) {
    return s.replace(r.every, (m) => {
        const kind = r.kindOf.get(m.toLowerCase());
        counts[kind]++;
        return ACCOUNT_PLACEHOLDERS[kind];
    });
}
/** `value` with every identifier replaced — in strings and in object keys — except at a linkage path. */
function replaceIn(value, r, counts, at) {
    if (typeof value === "string")
        return replaceInString(value, r, counts);
    if (!value || typeof value !== "object")
        return value;
    if (Array.isArray(value)) {
        for (let i = 0; i < value.length; i++) {
            at.push(String(i));
            if (!isLinkage(at))
                value[i] = replaceIn(value[i], r, counts, at);
            at.pop();
        }
        return value;
    }
    const o = value;
    let keyHolds = false;
    for (const k of Object.keys(o)) {
        at.push(k);
        if (!isLinkage(at))
            o[k] = replaceIn(o[k], r, counts, at);
        at.pop();
        if (r.once.test(k))
            keyHolds = true;
    }
    if (!keyHolds)
        return o;
    // a key that holds a value (a map keyed by path) is renamed, in place in the key order
    const renamed = {};
    for (const [k, v] of Object.entries(o))
        renamed[replaceInString(k, r, counts)] = v;
    return renamed;
}
/**
 * `value` — a record, or any JSON value prepare writes beside the transcripts
 * (a sub-agent's meta, the workflow runs, skill and plugin provenance) — with
 * every occurrence of the account's identifiers replaced by its placeholder,
 * counted into `counts`. Linkage values are never edited.
 */
export function replaceAccountIdentifiers(value, ids, counts) {
    const r = makeReplacer(ids);
    if (!r || !r.inJson.test(JSON.stringify(value) ?? ""))
        return value;
    return replaceIn(value, r, counts, []);
}
/** The record as it may be published, or null when its kind is not published. */
export function sanitizeRecord(rec, stats) {
    if (!isKeptRecord(rec))
        return null;
    for (const k of Object.keys(rec)) {
        if (KEEP_FIELDS.has(k))
            continue;
        delete rec[k];
        if (stats)
            stats.fields_dropped[k] = (stats.fields_dropped[k] ?? 0) + 1;
    }
    if ("toolUseResult" in rec) {
        const slim = slimToolUseResult(rec["toolUseResult"]);
        if (slim === undefined)
            delete rec["toolUseResult"];
        else
            rec["toolUseResult"] = slim;
    }
    if (rec["type"] === "assistant")
        stripThinkingSignatures(rec["message"]);
    const withheld = withholdInstructionsInRecord(rec);
    if (stats)
        stats.instruction_blocks_withheld += withheld;
    if (rec["type"] === "attachment") {
        const att = rec["attachment"];
        if (String(att["type"]).startsWith("hook_")) {
            // What a hook printed to stderr is its own diagnostics: nothing reads it,
            // and it is where tokens and paths end up. The firing itself is kept.
            const keep = att["type"] === "hook_additional_context" ? HOOK_CONTEXT_FIELDS : HOOK_FIELDS;
            for (const k of Object.keys(att)) {
                if (keep.has(k))
                    continue;
                delete att[k];
                // counted like an envelope field, under the firing's own name space
                if (stats)
                    stats.fields_dropped[`hook.${k}`] = (stats.fields_dropped[`hook.${k}`] ?? 0) + 1;
            }
            if (stats && hasInjection(att))
                stats.hook_injections++;
        }
    }
    return rec;
}
/**
 * The first of two passes, and the only one that parses every record: keeps and
 * minimises the records that are published, and adds the identifiers the
 * records left behind hold (and the desktop paths name) to `into`. The
 * identifiers are replaced by finishTranscript, once every transcript of the
 * session has been through this pass — a sub-agent's records may name an id
 * only the main transcript's dropped records hold, and the other way round.
 */
export function minimiseTranscript(jsonl, into = emptyAccountIdentifiers()) {
    scanDesktopLayouts(jsonl, into);
    const stats = {
        records_in: 0,
        records_kept: 0,
        records_dropped: 0,
        dropped_by_kind: {},
        fields_dropped: {},
        hook_injections: 0,
        instruction_blocks_withheld: 0,
        account_identifiers_replaced: zeroAccountCounts(),
        bytes_in: Buffer.byteLength(jsonl),
        bytes_out: 0,
        unparsable_lines: 0,
    };
    const out = [];
    for (const line of jsonl.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        let rec;
        try {
            const parsed = JSON.parse(s);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
                throw new Error("not a record");
            rec = parsed;
        }
        catch {
            // A half-written last line of a live transcript: not a record, not published.
            stats.unparsable_lines++;
            continue;
        }
        stats.records_in++;
        const kind = recordKind(rec);
        const kept = sanitizeRecord(rec, stats);
        if (kept === null) {
            stats.records_dropped++;
            stats.dropped_by_kind[kind] = (stats.dropped_by_kind[kind] ?? 0) + 1;
            visitDroppedRecord(rec, into); // sanitizeRecord leaves a record it does not keep untouched
            continue;
        }
        stats.records_kept++;
        out.push(JSON.stringify(kept));
    }
    return { lines: out, stats };
}
/**
 * The second pass: `m`'s records with every one of `ids` replaced by its
 * placeholder (only the records that hold one are parsed again), counted into
 * the returned stats. `m` itself is not changed.
 */
export function finishTranscript(m, ids) {
    const stats = { ...m.stats, account_identifiers_replaced: { ...m.stats.account_identifiers_replaced } };
    const replacer = makeReplacer(ids);
    const lines = replacer
        ? m.lines.map((line) => (replacer.inJson.test(line) ? JSON.stringify(replaceIn(JSON.parse(line), replacer, stats.account_identifiers_replaced, [])) : line))
        : m.lines;
    // U+2028 and U+2029 are legal inside a JSON string and Claude Code writes them as they
    // are, but a line reader that follows the Unicode line breaks (the server's) ends a
    // line at either: half a record, and the session cannot be published (review round 3,
    // R3-2). They occur only inside strings here, so the escape is the same JSON.
    const joined = lines.length > 0 ? lines.join("\n") + "\n" : "";
    const text = /[\u2028\u2029]/.test(joined) ? joined.replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029") : joined;
    stats.bytes_out = Buffer.byteLength(text);
    return { jsonl: text, stats };
}
/** Both passes over one transcript, replacing its own identifiers and `opts.accountIdentifiers`. */
export function sanitizeTranscript(jsonl, opts = {}) {
    const ids = emptyAccountIdentifiers();
    if (opts.accountIdentifiers)
        for (const k of ACCOUNT_IDENTIFIER_KINDS)
            for (const v of opts.accountIdentifiers[k])
                takeIdentifier(ids, k, v);
    return finishTranscript(minimiseTranscript(jsonl, ids), ids);
}
