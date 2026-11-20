// packages/ef-share-plugin/src/lib/authored.ts
//
// The publishing agent AUTHORS meaning — an automation kind's title and why, the
// chapters' titles and hints — and nothing else. Until 0.12 it also had to carry
// the extractor's whole output (every occurrence, every record uuid) back out
// through a tool call, by hand; one retyped uuid and the server dropped the
// panel. Now the agent writes two small files and these functions merge them
// into the extractor's output mechanically, so anchors are never retyped.
//
//   authored/automations.json   { "kinds": { "<kind_id>": { "title", "why", "category"?, "confidence"? } } }
//   authored/chapters.json      { "language"?: "ru", "chapters": [ { "start_record_ref", "title", "hint" } ] }
//
// Both are optional. A problem in either is returned as a message the agent can
// act on before the upload, instead of a silent server-side fallback after it —
// and "a problem" includes the quiet ones: a misspelt key ("titel"), an entry
// that is a string instead of an object, a chapter without its hint. Each of
// those used to pass with the extractor's placeholder title left in place
// (review 2026-11-16, P-15).
const CATEGORIES = ["safety", "context", "capture", "sync", "lifecycle", "other"];
const CONFIDENCE = ["high", "medium", "low"];
export const TITLE_MAX = 200;
export const WHY_MAX = 400;
export const CHAPTERS_MAX = 16;
export const CHAPTER_TITLE_MAX = 120;
export const CHAPTER_HINT_MAX = 200;
const AUTOMATION_KEYS = ["title", "why", "category", "confidence"];
const CHAPTER_KEYS = ["start_record_ref", "title", "hint"];
function unknownKeys(e, allowed) {
    return Object.keys(e).filter((k) => !allowed.includes(k));
}
/** Titles/whys for automation kinds, merged into the extractor's candidates. Occurrences and signatures' anchors are never touched. */
export function mergeAuthoredAutomations(candidates, authored) {
    const errors = [];
    let applied = 0;
    const kindsIn = authored && typeof authored === "object" ? authored["kinds"] : undefined;
    if (authored !== undefined && authored !== null && (!kindsIn || typeof kindsIn !== "object" || Array.isArray(kindsIn))) {
        errors.push(`authored automations: expected { "kinds": { "<kind_id>": { "title", "why" } } }`);
        return { value: candidates, errors, applied };
    }
    const byId = (kindsIn ?? {});
    const known = new Set(candidates.kinds.map((k) => k.kind_id));
    for (const id of Object.keys(byId))
        if (!known.has(id))
            errors.push(`authored automations: unknown kind_id "${id}" (not in the candidates file)`);
    const kinds = candidates.kinds.map((k) => {
        if (!(k.kind_id in byId))
            return k;
        const a = byId[k.kind_id];
        if (!a || typeof a !== "object" || Array.isArray(a)) {
            errors.push(`authored automations: ${k.kind_id} must be an object { "title", "why" }, got ${Array.isArray(a) ? "an array" : a === null ? "null" : `a ${typeof a}`}`);
            return k;
        }
        const e = a;
        for (const key of unknownKeys(e, AUTOMATION_KEYS))
            errors.push(`authored automations: ${k.kind_id} has an unknown key "${key}" (allowed: ${AUTOMATION_KEYS.join(", ")})`);
        const next = { ...k, signature: { ...k.signature } };
        let touched = false;
        if (e["title"] !== undefined) {
            const t = typeof e["title"] === "string" ? e["title"].trim() : "";
            if (!t)
                errors.push(`authored automations: ${k.kind_id} title must be a non-empty string`);
            else if (t.length > TITLE_MAX)
                errors.push(`authored automations: ${k.kind_id} title is ${t.length} characters (max ${TITLE_MAX})`);
            else {
                next.title = t;
                touched = true;
            }
        }
        if (e["why"] !== undefined) {
            const w = typeof e["why"] === "string" ? e["why"].trim() : "";
            if (!w)
                errors.push(`authored automations: ${k.kind_id} why must be a non-empty string`);
            else if (w.length > WHY_MAX)
                errors.push(`authored automations: ${k.kind_id} why is ${w.length} characters (max ${WHY_MAX})`);
            else {
                next.why = w;
                touched = true;
            }
        }
        if (e["category"] !== undefined) {
            if (CATEGORIES.includes(String(e["category"]))) {
                next.signature.category = e["category"];
                touched = true;
            }
            else
                errors.push(`authored automations: ${k.kind_id} category "${String(e["category"])}" is not one of ${CATEGORIES.join("|")}`);
        }
        if (e["confidence"] !== undefined) {
            if (CONFIDENCE.includes(String(e["confidence"]))) {
                next.confidence = String(e["confidence"]);
                touched = true;
            }
            else
                errors.push(`authored automations: ${k.kind_id} confidence "${String(e["confidence"])}" is not one of ${CONFIDENCE.join("|")}`);
        }
        if (touched)
            applied++;
        return next;
    });
    return { value: { ...candidates, kinds }, errors, applied };
}
/**
 * Chapters as the server will accept them: every anchor is a candidate turn's
 * own uuid, in transcript order, no anchor twice (the server's rules, checked
 * here so a mistake is fixed before the upload rather than replaced by its
 * time-gap fallback after it).
 */
export function validateAuthoredChapters(candidates, authored) {
    const errors = [];
    if (authored === undefined || authored === null)
        return { value: null, errors, applied: 0 };
    const list = authored && typeof authored === "object" ? authored["chapters"] : undefined;
    if (!Array.isArray(list)) {
        errors.push(`authored chapters: expected { "language"?, "chapters": [ { "start_record_ref", "title", "hint" } ] }`);
        return { value: null, errors, applied: 0 };
    }
    if (list.length === 0)
        return { value: null, errors, applied: 0 };
    if (list.length > CHAPTERS_MAX)
        errors.push(`authored chapters: ${list.length} chapters (max ${CHAPTERS_MAX})`);
    const order = new Map(candidates.turns.map((t, i) => [t.start_record_ref, i]));
    const out = [];
    let prev = -1;
    let firstPos; // where chapters[0] starts — undefined when chapters[0] itself is wrong
    list.forEach((c, i) => {
        const at = `authored chapters[${i}]`;
        if (!c || typeof c !== "object" || Array.isArray(c)) {
            errors.push(`${at}: not an object`);
            return;
        }
        const e = c;
        for (const key of unknownKeys(e, CHAPTER_KEYS))
            errors.push(`${at}: unknown key "${key}" (allowed: ${CHAPTER_KEYS.join(", ")})`);
        const ref = typeof e["start_record_ref"] === "string" ? e["start_record_ref"] : "";
        const pos = order.get(ref);
        if (pos === undefined) {
            errors.push(`${at}: start_record_ref "${ref}" is not a turn in the candidates file`);
            return;
        }
        if (i === 0)
            firstPos = pos;
        if (pos <= prev)
            errors.push(`${at}: chapters must follow transcript order, one per turn (turn ${pos + 1} after turn ${prev + 1})`);
        prev = pos;
        const title = typeof e["title"] === "string" ? e["title"].trim() : "";
        if (!title)
            errors.push(`${at}: title is missing`);
        else if (title.length > CHAPTER_TITLE_MAX)
            errors.push(`${at}: title is ${title.length} characters (max ${CHAPTER_TITLE_MAX})`);
        const hint = typeof e["hint"] === "string" ? e["hint"].trim() : "";
        if (!hint)
            errors.push(`${at}: hint is missing — one line, in the session's language, on what happens in the chapter`);
        else if (hint.length > CHAPTER_HINT_MAX)
            errors.push(`${at}: hint is ${hint.length} characters (max ${CHAPTER_HINT_MAX})`);
        out.push({ start_record_ref: ref, title, ...(hint ? { hint } : {}) });
    });
    // Said about chapters[0] only when chapters[0] is what is wrong with it; a bad
    // ref there has its own message above.
    if (firstPos !== undefined && firstPos !== 0) {
        errors.push(`authored chapters[0]: the first chapter must start at the first turn of the candidates file`);
    }
    let language;
    const lang = authored["language"];
    if (lang !== undefined) {
        if (typeof lang === "string" && /^[a-z]{2,8}$/.test(lang))
            language = lang;
        else
            errors.push(`authored chapters: language "${String(lang)}" must be a lowercase primary tag such as "en" or "ru"`);
    }
    return { value: errors.length === 0 ? { ...(language ? { language } : {}), chapters: out } : null, errors, applied: out.length };
}
