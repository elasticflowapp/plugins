import fs from "node:fs";
import { extractHiddenRecords } from "../src/lib/hidden-records.js";
const path = process.argv[2];
if (!path) {
    console.error("usage: extract-hidden-records <transcript.jsonl>");
    process.exit(2);
}
const jsonl = fs.readFileSync(path, "utf-8");
process.stdout.write(JSON.stringify(extractHiddenRecords(jsonl)));
