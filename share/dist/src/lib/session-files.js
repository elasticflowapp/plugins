// packages/ef-share-plugin/src/lib/session-files.ts
//
// Where Claude Code keeps the parts of a session that are NOT in the main
// transcript (measured 2026-11-16 on 2.1.281–2.1.325; documented for sub-agents
// at code.claude.com/docs/en/sub-agents):
//
//   <project>/<sessionId>.jsonl                                   main transcript
//   <project>/<sessionId>/subagents/agent-<id>.jsonl              one per sub-agent
//   <project>/<sessionId>/subagents/agent-<id>.meta.json          its type, description, tool_use id
//   <project>/<sessionId>/subagents/workflows/<runId>/agent-*.…   agents a Workflow run spawned
//   <project>/<sessionId>/workflows/<runId>.json                  the Workflow run's own record
//
// The main transcript holds no sub-agent records any more (0 `isSidechain` lines
// in 70 local sessions), so a publish that uploads only the main file shows a
// reader none of the delegated work.
import fs from "node:fs";
import path from "node:path";
const AGENT_FILE = /^agent-([A-Za-z0-9_-]{1,80})\.jsonl$/;
const RUN_ID = /^[A-Za-z0-9_-]{1,80}$/;
/** `<project>/<sessionId>.jsonl` → `<project>/<sessionId>` */
export function sessionDirFor(transcriptPath) {
    const resolved = path.resolve(transcriptPath);
    return path.join(path.dirname(resolved), path.basename(resolved, ".jsonl"));
}
function isDir(p) {
    try {
        return fs.statSync(p).isDirectory();
    }
    catch {
        return false;
    }
}
function agentsIn(dir, workflowRunId) {
    let names;
    try {
        names = fs.readdirSync(dir);
    }
    catch {
        return [];
    }
    const out = [];
    for (const name of names.sort()) {
        const m = AGENT_FILE.exec(name);
        if (!m)
            continue;
        const metaPath = path.join(dir, `agent-${m[1]}.meta.json`);
        out.push({
            agentId: m[1],
            jsonlPath: path.join(dir, name),
            metaPath: fs.existsSync(metaPath) ? metaPath : null,
            workflowRunId,
        });
    }
    return out;
}
/** Every sub-agent transcript of the session: direct ones first, then per Workflow run. */
export function listSubagentFiles(transcriptPath) {
    const subDir = path.join(sessionDirFor(transcriptPath), "subagents");
    if (!isDir(subDir))
        return [];
    const out = agentsIn(subDir, null);
    const wfRoot = path.join(subDir, "workflows");
    if (isDir(wfRoot)) {
        for (const runId of fs.readdirSync(wfRoot).sort()) {
            if (!RUN_ID.test(runId))
                continue;
            const runDir = path.join(wfRoot, runId);
            if (isDir(runDir))
                out.push(...agentsIn(runDir, runId));
        }
    }
    return out;
}
function str(v) { return typeof v === "string" && v ? v : null; }
function num(v) { return typeof v === "number" && Number.isFinite(v) ? v : null; }
const plainCut = (text, max) => text.slice(0, max);
/**
 * The run records of the session, whole — the script included. prepare reads them
 * for the ids a path in them names BEFORE it writes anything (release review
 * 2026-11-20, note 4); what is published of a run is describeWorkflowRun's.
 */
export function readWorkflowRunRecords(transcriptPath) {
    const wfDir = path.join(sessionDirFor(transcriptPath), "workflows");
    if (!isDir(wfDir))
        return [];
    const out = [];
    for (const name of fs.readdirSync(wfDir).sort()) {
        if (!name.endsWith(".json"))
            continue;
        let raw;
        try {
            raw = JSON.parse(fs.readFileSync(path.join(wfDir, name), "utf-8"));
        }
        catch {
            continue;
        }
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
            continue;
        const runId = str(raw["runId"]) ?? path.basename(name, ".json");
        if (!RUN_ID.test(runId))
            continue;
        out.push({ runId, raw: raw });
    }
    return out;
}
/**
 * What is published of a run. The run's script is left out on purpose: it is
 * already in the transcript as the Workflow tool call's input, where redaction
 * can reach it. The texts that have a limit go through `cut`.
 */
export function describeWorkflowRun({ runId, raw }, cut = plainCut) {
    const phases = Array.isArray(raw["phases"]) ? raw["phases"] : [];
    const summary = str(raw["summary"]);
    return {
        run_id: runId,
        name: str(raw["workflowName"]),
        status: str(raw["status"]),
        started_at: str(raw["timestamp"]),
        duration_ms: num(raw["durationMs"]),
        agent_count: num(raw["agentCount"]),
        total_tokens: num(raw["totalTokens"]),
        total_tool_calls: num(raw["totalToolCalls"]),
        default_model: str(raw["defaultModel"]),
        summary: summary === null ? null : cut(summary, 600),
        phases: phases
            .filter((p) => !!p && typeof p === "object")
            // a phase is one only when it has a title: tested on the title as recorded, before anything is cut
            .filter((p) => str(p["title"]) !== null)
            .slice(0, 24)
            .map((p) => {
            const detail = str(p["detail"]);
            return { title: cut(str(p["title"]), 120), detail: detail === null ? null : cut(detail, 300) };
        }),
    };
}
/** The Workflow runs of the session, as their own run records describe them. */
export function listWorkflowRuns(transcriptPath, cut = plainCut) {
    return readWorkflowRunRecords(transcriptPath).map((r) => describeWorkflowRun(r, cut));
}
