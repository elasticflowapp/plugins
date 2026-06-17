import fs from "node:fs";
import { extractChapterCandidates } from "../src/lib/chapters.js";
const path = process.argv[2];
if (!path) {
    console.error("usage: extract-chapters <transcript.jsonl>");
    process.exit(2);
}
const jsonl = fs.readFileSync(path, "utf-8");
process.stdout.write(JSON.stringify(extractChapterCandidates(jsonl)));
