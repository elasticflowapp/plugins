function phaseOf(n) {
    const h = (n.split(":")[0] ?? "").trim();
    return { SessionStart: "session_start", Stop: "session_end", SubagentStop: "subagent_end", UserPromptSubmit: "user_prompt", PreToolUse: "before_tool", PostToolUse: "after_tool", PostToolUseFailure: "after_tool", PreCompact: "before_compact", Notification: "notification" }[h] ?? "other";
}
// Mirrors viewer/lib/automations/raw-firings.ts sourceFromText (incl. the
// content-slug fallback: plugins self-name in their injected text when the
// transcript carries no command/marker).
const CONTENT_SLUGS = [
    [/\bef-share\b|elasticflow share/i, "ef-share"],
    [/oh-my-claudecode\b/i, "oh-my-claudecode"],
    [/\bsuperpowers\b/i, "superpowers"],
    [/\bralph-loop\b/i, "ralph-loop"],
    [/\b8hats\b/i, "8hats"],
];
function sourceOf(text) {
    const mcp = /mcp__plugin_([a-z0-9-]+)__/i.exec(text);
    if (mcp)
        return { kind: "mcp", ref: mcp[1] };
    const cache = /\/plugins\/cache\/([^/]+)\//i.exec(text);
    if (cache)
        return { kind: "plugin", ref: cache[1] };
    const known = { "persistent-mode.cjs": "oh-my-claudecode", "context-guard-stop.mjs": "oh-my-claudecode", "code-simplifier.mjs": "oh-my-claudecode" };
    const base = /([a-z0-9_-]+\.(?:c?js|mjs|sh|ts))/i.exec(text);
    if (base && known[base[1]])
        return { kind: "plugin", ref: known[base[1]] };
    for (const [re, slug] of CONTENT_SLUGS)
        if (re.test(text))
            return { kind: "plugin", ref: slug };
    return { kind: "core", ref: "claude-code" };
}
function successInjection(stdout) {
    if (typeof stdout !== "string" || !stdout)
        return "";
    try {
        return String(JSON.parse(stdout)?.hookSpecificOutput?.additionalContext ?? "");
    }
    catch {
        return "";
    }
}
function* records(jsonl) {
    for (const line of jsonl.split("\n")) {
        const s = line.trim();
        if (!s)
            continue;
        try {
            yield JSON.parse(s);
        }
        catch { /* skip */ }
    }
}
function firings(jsonl) {
    const out = [];
    for (const r of records(jsonl)) {
        const uuid = r["uuid"] ? String(r["uuid"]) : null;
        if (!uuid)
            continue;
        const ts = r["timestamp"] ? String(r["timestamp"]) : null;
        if (r["type"] === "attachment") {
            const a = (r["attachment"] ?? {});
            if (a["type"] !== "hook_additional_context" && a["type"] !== "hook_success")
                continue;
            const native = String(a["hookName"] || a["hookEvent"] || "");
            const contentText = a["type"] === "hook_additional_context"
                ? (Array.isArray(a["content"]) ? a["content"].map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n") : "")
                : successInjection(a["stdout"]);
            const inj = contentText.length > 0;
            const s = sourceOf(`${String(a["command"] ?? "")} ${native} ${contentText.slice(0, 500)}`);
            out.push({ uuid, nativeEvent: native, phase: phaseOf(native), sourceKind: s.kind, sourceRef: s.ref, hasInjection: inj, ts });
        }
        else if (r["type"] === "system" && r["subtype"] === "stop_hook_summary") {
            const hookInfos = Array.isArray(r["hookInfos"]) ? r["hookInfos"] : [];
            const cmd = hookInfos.map((h) => String(h["command"] ?? "")).join(" ");
            const s = sourceOf(cmd);
            out.push({ uuid, nativeEvent: "Stop", phase: "session_end", sourceKind: s.kind, sourceRef: s.ref, hasInjection: false, ts });
        }
    }
    return out;
}
// Floor rules. Phase wins for tool hooks (a PreToolUse reminder that injects
// context is still a "safety check", not "context loading"); injection->context
// applies only to the remaining lifecycle-phase firings (SessionStart guide,
// UserPromptSubmit context). sync is detected first by keyword.
function classify(f) {
    const text = `${f.nativeEvent} ${f.sourceRef}`.toLowerCase();
    if (/publish|sync|upload|share_|authenticate/.test(text))
        return { category: "sync", action: "external_action" };
    if (f.phase === "before_tool")
        return { category: "safety", action: "gate" };
    if (f.phase === "after_tool")
        return { category: "capture", action: "capture" };
    if (f.phase === "session_end" || f.phase === "before_compact" || f.phase === "subagent_end")
        return { category: "lifecycle", action: "housekeeping" };
    if (f.hasInjection)
        return { category: "context", action: "inject_context" };
    if (f.phase === "session_start")
        return { category: "lifecycle", action: "housekeeping" };
    if (f.phase === "notification")
        return { category: "other", action: "notify" };
    return { category: "other", action: "unknown" };
}
function genericTitle(c) {
    return { safety: "Safety check", context: "Loaded context", capture: "Captured tool result", sync: "Synced", lifecycle: "Session housekeeping", other: "Background action" }[c];
}
export function extractAutomationCandidates(jsonl) {
    const fs = firings(jsonl).slice(0, 20000);
    const kindByKey = new Map();
    const kinds = [];
    const occurrences = [];
    for (const f of fs) {
        const { category, action } = classify(f);
        const key = `${category}|${action}|${f.phase}|${f.nativeEvent}|${f.sourceKind}|${f.sourceRef}`;
        let kindId = kindByKey.get(key);
        if (!kindId) {
            kindId = `k${kinds.length + 1}`;
            kindByKey.set(key, kindId);
            kinds.push({ kind_id: kindId, signature: { category, action_kind: action, trigger_phase: f.phase, native_event: f.nativeEvent, source_kind: f.sourceKind, source_ref: f.sourceRef }, title: genericTitle(category), why: "", classified_by: "rule", confidence: "low" });
            if (kinds.length >= 200)
                break;
        }
        occurrences.push({ kind_id: kindId, ts: f.ts, turn_idx: 0, record_ref: f.uuid, error: false });
    }
    return { automation_contract_version: "1.0.0", runtime: "claude-code", kinds, occurrences };
}
