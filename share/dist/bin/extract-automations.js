import fs from "node:fs";
import { extractAutomationCandidates } from "../src/lib/automations.js";
const path = process.argv[2];
if (!path) {
    console.error("usage: extract-automations <transcript.jsonl>");
    process.exit(2);
}
const jsonl = fs.readFileSync(path, "utf-8");
process.stdout.write(JSON.stringify(extractAutomationCandidates(jsonl)));
