import { spawn } from "node:child_process";
export function openUrl(url) {
    // Use spawn with array args + shell:false to prevent command injection.
    const cmd = process.platform === "darwin" ? "open"
        : process.platform === "win32" ? "explorer"
            : "xdg-open";
    const child = spawn(cmd, [url], { stdio: "ignore", detached: true, shell: false });
    child.unref();
}
