import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { extractAllPluginProvenance } from "../src/lib/plugins.js";
// Resolve the plugins root: EF_SHARE_PLUGINS_ROOT > ~/.claude/plugins
const pluginsRoot = process.env.EF_SHARE_PLUGINS_ROOT ?? path.join(os.homedir(), ".claude", "plugins");
function readJson(filePath) {
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf-8"));
    }
    catch {
        return null;
    }
}
const installed = readJson(path.join(pluginsRoot, "installed_plugins.json"));
const marketplaces = readJson(path.join(pluginsRoot, "known_marketplaces.json"));
function readManifest(marketplace, installLocation) {
    return readJson(path.join(installLocation, ".claude-plugin", "marketplace.json"));
}
const result = extractAllPluginProvenance(installed, marketplaces, readManifest);
process.stdout.write(JSON.stringify(result));
