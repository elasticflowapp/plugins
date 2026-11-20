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
/**
 * The Workflow runs of the session, as their own run records describe them.
 * The run's script is left out on purpose: it is already in the transcript as
 * the Workflow tool call's input, where redaction can reach it.
 */
export function listWorkflowRuns(transcriptPath) {
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
        const runId = str(raw["runId"]) ?? path.basename(name, ".json");
        if (!RUN_ID.test(runId))
            continue;
        const phases = Array.isArray(raw["phases"]) ? raw["phases"] : [];
        out.push({
            run_id: runId,
            name: str(raw["workflowName"]),
            status: str(raw["status"]),
            started_at: str(raw["timestamp"]),
            duration_ms: num(raw["durationMs"]),
            agent_count: num(raw["agentCount"]),
            total_tokens: num(raw["totalTokens"]),
            total_tool_calls: num(raw["totalToolCalls"]),
            default_model: str(raw["defaultModel"]),
            summary: str(raw["summary"])?.slice(0, 600) ?? null,
            phases: phases
                .filter((p) => !!p && typeof p === "object")
                .map((p) => ({ title: (str(p["title"]) ?? "").slice(0, 120), detail: str(p["detail"])?.slice(0, 300) ?? null }))
                .filter((p) => p.title)
                .slice(0, 24),
        });
    }
    return out;
}
