// packages/ef-share-plugin/src/lib/account-records.ts
//
// The records the Claude apps on this machine keep of the account each is signed
// in to. prepare replaces those accounts' identifiers wherever they stand in what
// is published (sanitize.ts) — a terminal session records none of them, yet a
// command's output prints the address.
//
// There is more than one such record, and they can name different accounts
// (release review 2026-11-20, note 1, which measured the desktop account's address
// in the uploads of 15 terminal sessions, 348 times. This change's own scan,
// 2026-11-21: nine desktop records, none naming the terminal account's address;
// 0.12.0 left that other address in the files of 12 of 181 sessions, 242 times):
//
//   $CLAUDE_CONFIG_DIR/.claude.json      the Claude Code that runs /share, when it
//                                        has a config directory of its own
//   ~/.claude.json                       the terminal Claude Code
//   <Claude>/local-agent-mode-sessions/<account>/<organisation>/local_<id>/.claude/.claude.json
//                                        the desktop app: one per session, each the
//                                        config file of the Claude Code it ran
//
// <Claude> is the desktop app's data folder: ~/Library/Application Support/Claude,
// %APPDATA%\Claude, $XDG_CONFIG_HOME/Claude or ~/.config/Claude. The session
// folder names the account and the organisation by position, so a session whose
// record is gone still names both ids.
//
// From a record exactly three fields are read — `oauthAccount.accountUuid`,
// `.organizationUuid`, `.emailAddress` — and each is taken only when it has the
// shape of one (sanitize.ts takeAccountFields). Nothing else of the file is
// looked at and no value is printed. A file that is not there names nothing; one
// that is there and cannot be used — not a regular file, over RECORD_MAX_BYTES,
// not a JSON object — is counted, and prepare says so (review of 0.12.1, R1-8).
// Of one account's desktop sessions the newest RECORDS_PER_ACCOUNT records are
// read: every account is read, however many sessions another one has (R1-7), and
// a session folder that holds no record does not count towards the limit (R2-2).
import fs from "node:fs";
import path from "node:path";
import { takeAccountFields, takeAccountIdentifier } from "./sanitize.js";
const UUID_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/**
 * The largest file read as a record. Claude Code's own config file grows with every
 * project it remembers (measured: 0.4 MB on one machine; a desktop session's, 38 KB
 * at most) and 0.12.0 read it at any size — the limit is far above any real one and
 * only keeps a file that is something else out of memory (review of 0.12.1, R1-3:
 * at 8 MB it silently stopped reading a real config file).
 */
export const RECORD_MAX_BYTES = 64 * 1024 * 1024;
/** Desktop session records read for ONE account (an `<account>/<organisation>` folder), newest first: its sessions repeat the same three values. */
export const RECORDS_PER_ACCOUNT = 200;
function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
/** The desktop app's session folders that exist on this machine. */
export function desktopSessionsDirs(env, home) {
    const data = [
        path.join(home, "Library", "Application Support", "Claude"),
        path.join(env["XDG_CONFIG_HOME"] || path.join(home, ".config"), "Claude"),
        ...(env["APPDATA"] ? [path.join(env["APPDATA"], "Claude")] : []),
    ];
    const out = [];
    for (const d of data) {
        const dir = path.join(d, "local-agent-mode-sessions");
        if (!out.includes(dir) && isDir(dir))
            out.push(dir);
    }
    return out;
}
/** Where the account records of this machine's Claude apps are. */
export function accountRecordSources(env, home) {
    const files = [];
    for (const dir of [env["CLAUDE_CONFIG_DIR"], home]) {
        if (!dir)
            continue;
        const file = path.join(dir, ".claude.json");
        if (!files.includes(file))
            files.push(file);
    }
    return { files, desktopSessionsDirs: desktopSessionsDirs(env, home) };
}
/** `file`'s `oauthAccount`, into `into`: "read", "absent" (no such file) or "unreadable" (there, and not a record that can be used). */
function readRecord(file, into) {
    let st;
    // A link is followed: where the file lives is the person's own choice, and what is read
    // can only add to what is REPLACED. A folder, a pipe or a device in its place is not read.
    try {
        st = fs.statSync(file);
    }
    catch (e) {
        return e.code === "ENOENT" ? "absent" : "unreadable";
    }
    if (!st.isFile() || st.size > RECORD_MAX_BYTES)
        return "unreadable";
    let config;
    try {
        config = JSON.parse(fs.readFileSync(file, "utf-8"));
    }
    catch {
        return "unreadable";
    }
    if (!config || typeof config !== "object" || Array.isArray(config))
        return "unreadable";
    takeAccountFields(config["oauthAccount"], into);
    return "read";
}
function subfolders(dir) {
    try {
        return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
    }
    catch {
        return [];
    }
}
/** The session folders of one account, the most recently used first. */
function sessionsNewestFirst(dir) {
    const at = (name) => { try {
        return fs.statSync(path.join(dir, name)).mtimeMs;
    }
    catch {
        return 0;
    } };
    return subfolders(dir).filter((name) => name.startsWith("local_")).map((name) => ({ name, t: at(name) })).sort((a, b) => b.t - a.t || a.name.localeCompare(b.name)).map((s) => s.name);
}
/**
 * Adds to `into` the identifiers of every account `sources` names: by field from
 * each record, by position from the desktop app's session folders. Returns what
 * was read, what was left unread and what could not be used — counts, never a value.
 */
export function readAccountRecords(sources, into) {
    const out = { records_read: 0, records_not_read: 0, records_unreadable: 0 };
    const tally = (how) => {
        if (how === "read")
            out.records_read++;
        else if (how === "unreadable")
            out.records_unreadable++;
    };
    for (const file of sources.files)
        tally(readRecord(file, into));
    for (const root of sources.desktopSessionsDirs) {
        for (const account of subfolders(root)) {
            if (!UUID_NAME.test(account))
                continue; // `skills-plugin` and whatever else is kept beside the accounts
            for (const organisation of subfolders(path.join(root, account))) {
                if (!UUID_NAME.test(organisation))
                    continue;
                takeAccountIdentifier(into, "account_id", account);
                takeAccountIdentifier(into, "organisation_id", organisation);
                // each account has a limit of its own: one with thousands of sessions does not use up another's.
                // The limit is of records READ — a session folder without one takes nothing from it.
                let readHere = 0;
                for (const session of sessionsNewestFirst(path.join(root, account, organisation))) {
                    const file = path.join(root, account, organisation, session, ".claude", ".claude.json");
                    if (readHere >= RECORDS_PER_ACCOUNT) {
                        if (fs.existsSync(file))
                            out.records_not_read++;
                        continue;
                    }
                    const how = readRecord(file, into);
                    if (how === "read")
                        readHere++;
                    tally(how);
                }
            }
        }
    }
    return out;
}
