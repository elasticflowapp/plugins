import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
function credsPath() {
    return path.join(os.homedir(), ".config", "ef-share", "credentials.json");
}
export async function writeCredentials(c) {
    const dir = path.dirname(credsPath());
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });
    await fs.writeFile(credsPath(), JSON.stringify(c, null, 2), { mode: 0o600 });
}
export async function readCredentials() {
    try {
        return JSON.parse(await fs.readFile(credsPath(), "utf-8"));
    }
    catch {
        return null;
    }
}
