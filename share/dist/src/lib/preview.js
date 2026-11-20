// packages/ef-share-plugin/src/lib/preview.ts
//
// A picture of a result page, taken on the author's machine when they publish
// it — so a reader of the session sees what the result IS before they run it.
//
// Where and how the picture is taken matters:
//   - here, the page is the author's own and the browser is theirs; nothing of
//     it runs in a reader's browser until the reader presses Run, and the
//     server never has to execute a page it was sent;
//   - the page is served to the browser by a local server that hands out ONLY
//     the files the result publishes, with the response policy the site will
//     apply (viewer/lib/results/headers.ts). A file:// page would be a
//     different page: module scripts and fetch do not load from file://, and a
//     reference to a file that is not published would resolve;
//   - the browser is pointed at a WRAPPER page that holds the result in a
//     sandboxed frame, the way the session page does, and that wrapper allows
//     the frame this local origin only (`frame-src`). A result page that
//     navigates itself away is stopped there exactly as it is on the site —
//     opened as the top-level page it would take the browser wherever it
//     liked, and the picture of THAT page would be published (review
//     2026-11-16, C-1: a page that set `location.href` got a picture of a
//     service on the author's own machine).
//
// The picture is the page as it looks once it has loaded and its first few
// seconds of timers have run, in a 1024 px wide window, in the light colour
// scheme. An animation is caught near its start. A reader's frame has its own
// width and their browser is their own, so it is a picture of the result, not
// a promise of every pixel.
//
// It needs a Chromium-family browser (Chrome, Edge, Chromium, Brave). When
// there is none, or it does not produce a picture in time, the result is
// published without one and the caller is told why. Nothing here throws.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, spawnSync } from "node:child_process";
import { RESULT_MIME } from "./result-types.js";
import { isFlatPng, trimPngBottom } from "./png.js";
export const PREVIEW = {
    // Near the width a reader's frame has on a desktop, not a full desktop window: the page lays
    // out much as it will for them, and its text is still legible when the picture is drawn small
    // (review 2026-11-16, U-7: a 1280 px picture shown 394 px wide had 4 px text).
    width: 1024,
    height: 640,
    /** what the server takes for one preview (viewer/lib/uploads/staged-upload.ts UPLOAD_LIMITS.resultPreviewBytes) */
    maxBytes: 3 * 1024 * 1024,
    /** the server's bounds for a side, in pixels (viewer/lib/results/png.ts PREVIEW_PIXELS) */
    minPixels: 64,
    maxPixels: 4096,
    /** blank rows at the bottom of the window are cut — never below this height, with this margin under the last row that differs */
    minHeight: 336,
    bottomMargin: 48,
    /** time the page gets to draw itself (virtual: its timers run ahead and what it fetches is waited for; an animation is caught near its start) */
    settleMs: 4000,
    /** a page still loading after this (a stream, a host that never answers) is photographed as it stands */
    stopLoadingMs: 8000,
    /** wall-clock limit for ONE result's picture, every attempt included */
    timeoutMs: 20_000,
    /** wall-clock limit for all the pictures of one upload (the upload ticket lives 300 s) */
    totalMs: 60_000,
};
/** How the session page frames a result (viewer/lib/results/url.ts RESULT_SANDBOX). */
export const RESULT_SANDBOX = "allow-scripts allow-pointer-lock";
/** The wrapper page's path on the local server. `!` cannot be in a result file's name, so it never collides with one. */
export const FRAME_PATH = "!frame.html";
const MAC_APPS = [
    ["Google Chrome.app", "Google Chrome"],
    ["Chromium.app", "Chromium"],
    ["Microsoft Edge.app", "Microsoft Edge"],
    ["Brave Browser.app", "Brave Browser"],
];
const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "brave-browser"];
const WINDOWS_PATHS = [
    ["Google", "Chrome", "Application", "chrome.exe"],
    ["Microsoft", "Edge", "Application", "msedge.exe"],
    ["Chromium", "Application", "chrome.exe"],
    ["BraveSoftware", "Brave-Browser", "Application", "brave.exe"],
];
/** `EF_SHARE_PREVIEW=off` turns the pictures off. */
export function previewsOff(env = process.env) {
    return (env["EF_SHARE_PREVIEW"] ?? "").toLowerCase() === "off";
}
/**
 * A Chromium-family browser on this machine, or null. `EF_SHARE_BROWSER` names
 * one explicitly; `EF_SHARE_PREVIEW=off` turns the picture off.
 */
export function findBrowser(env = process.env, platform = process.platform, exists = fs.existsSync, home = os.homedir()) {
    if (previewsOff(env))
        return null;
    const named = env["EF_SHARE_BROWSER"];
    if (named)
        return exists(named) ? named : null;
    const candidates = [];
    if (platform === "darwin") {
        for (const root of ["/Applications", path.join(home, "Applications")]) {
            for (const [app, bin] of MAC_APPS)
                candidates.push(path.join(root, app, "Contents", "MacOS", bin));
        }
    }
    else if (platform === "win32") {
        for (const root of [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]) {
            if (root)
                for (const parts of WINDOWS_PATHS)
                    candidates.push(path.win32.join(root, ...parts));
        }
    }
    else {
        for (const dir of (env["PATH"] ?? "").split(":")) {
            if (dir)
                for (const name of LINUX_NAMES)
                    candidates.push(path.join(dir, name));
        }
    }
    return candidates.find((c) => exists(c)) ?? null;
}
/** Why `findBrowser` came back empty — the true reason, since the advice differs for each. */
export function whyNoBrowser(env = process.env) {
    if (previewsOff(env))
        return "preview pictures are turned off (EF_SHARE_PREVIEW=off)";
    const named = env["EF_SHARE_BROWSER"];
    if (named)
        return `EF_SHARE_BROWSER names ${named}, which does not exist`;
    return "no Chrome, Edge, Chromium or Brave was found on this machine (set EF_SHARE_BROWSER to the browser's path)";
}
/** Width and height of a PNG, or null when `buf` is not one. */
export function pngSize(buf) {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    if (buf.length < 24 || sig.some((b, i) => buf[i] !== b))
        return null;
    if (String.fromCharCode(buf[12], buf[13], buf[14], buf[15]) !== "IHDR")
        return null;
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    if (view.getUint32(8) !== 13)
        return null; // an IHDR is 13 bytes; anything else is not a header to read a size from
    const width = view.getUint32(16);
    const height = view.getUint32(20);
    return width > 0 && height > 0 ? { width, height } : null;
}
/** The policy the site sends with every result file, for this local origin. */
export function previewPolicy(origin, remoteHosts) {
    const declared = remoteHosts.filter((h) => /^[A-Za-z0-9.-]{1,253}(?::\d{1,5})?$/.test(h)).slice(0, 20).map((h) => `https://${h}`);
    const sources = ["'self'", origin, ...declared, "data:", "blob:", "'unsafe-inline'", "'unsafe-eval'"].join(" ");
    return [`sandbox ${RESULT_SANDBOX}`, `default-src ${sources}`, "object-src 'none'", "base-uri 'none'", "form-action 'none'"].join("; ");
}
/** The wrapper: one sandboxed frame holding the entry page, filling the window. */
export function framePage(entry) {
    // encodeURIComponent leaves nothing that could end a double-quoted attribute
    const src = "/" + entry.split("/").map(encodeURIComponent).join("/");
    return "<!doctype html><html><head><meta charset=\"utf-8\"><title>Result preview</title>" +
        "<style>html,body{margin:0;height:100%;background:#fff;overflow:hidden}iframe{display:block;border:0;width:100%;height:100%}</style></head>" +
        `<body><iframe src="${src}" sandbox="${RESULT_SANDBOX}" referrerpolicy="no-referrer" allow=""></iframe></body></html>`;
}
/**
 * Serve exactly `files` on a loopback port, as the site will serve them: a
 * request for anything else is 404. With `entry`, the wrapper page is served at
 * FRAME_PATH. Returns the origin and a function to stop.
 */
export async function serveResultFiles(files, remoteHosts, entry) {
    const byRel = new Map(files.map((f) => [f.rel.normalize("NFC"), f.abs]));
    let origin = "";
    const notFound = (res) => { res.writeHead(404, { "Content-Type": "text/plain" }); res.end("Not found"); };
    const server = http.createServer((req, res) => {
        let rel;
        try {
            rel = decodeURIComponent((req.url ?? "/").split(/[?#]/)[0]).replace(/^\/+/, "").normalize("NFC");
        }
        catch {
            rel = "";
        }
        if (req.method !== "GET" && req.method !== "HEAD") {
            notFound(res);
            return;
        }
        if (entry !== undefined && rel === FRAME_PATH) {
            res.writeHead(200, {
                "Content-Type": "text/html; charset=utf-8",
                // the frame may hold this origin and nothing else, now and after any navigation of it
                "Content-Security-Policy": `default-src 'none'; frame-src ${origin}; style-src 'unsafe-inline'`,
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
            });
            res.end(req.method === "HEAD" ? undefined : framePage(entry));
            return;
        }
        const abs = byRel.get(rel);
        if (!abs) {
            notFound(res);
            return;
        }
        let data;
        try {
            data = fs.readFileSync(abs);
        }
        catch {
            notFound(res);
            return;
        }
        const mime = RESULT_MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream";
        res.writeHead(200, {
            "Content-Type": /^text\/|javascript|json/.test(mime) ? `${mime}; charset=utf-8` : mime,
            "Content-Security-Policy": previewPolicy(origin, remoteHosts),
            "X-Content-Type-Options": "nosniff",
            "Referrer-Policy": "no-referrer",
            "Access-Control-Allow-Origin": "*",
            "Cache-Control": "no-store",
        });
        res.end(req.method === "HEAD" ? undefined : data);
    });
    await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    return { origin, close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }) };
}
const live = new Set();
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
function killTree(pid) {
    if (!pid)
        return;
    if (process.platform === "win32") {
        try {
            spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        }
        catch { /* already gone */ }
        return;
    }
    try {
        process.kill(-pid, "SIGKILL");
    }
    catch { /* no such group: already gone */ }
    try {
        process.kill(pid, "SIGKILL");
    }
    catch { /* already gone */ }
}
function reap(c) {
    killTree(c.pid);
    killTree(c.reaper);
    c.reaper = undefined;
    try {
        fs.rmSync(c.profile, { recursive: true, force: true });
    }
    catch { /* the browser may still hold a file for a moment */ }
}
/**
 * Something that ends the browser when this process cannot. Killed outright (SIGKILL — a
 * runner's hard timeout) this process runs no handler, and a page that never yields keeps the
 * browser's own stop from firing: the whole tree then ran on, one renderer at full load
 * (verification 2026-11-17, V-7). So a small shell waits out the limit in a process group of
 * its own and kills the browser's group — after checking that the group's leader is still a
 * browser started for a preview, since a process id can be given to something else. A capture
 * that ends normally ends the reaper first.
 */
export function startReaper(pid, seconds) {
    if (process.platform === "win32" || !pid || !Number.isInteger(pid) || pid < 2)
        return undefined;
    const wait = Math.max(1, Math.ceil(seconds));
    const script = `sleep ${wait}; if ps -o command= -p ${pid} 2>/dev/null | grep -q -- "ef-share-preview-"; then kill -9 -${pid} 2>/dev/null; kill -9 ${pid} 2>/dev/null; fi`;
    try {
        const reaper = spawn("/bin/sh", ["-c", script], { stdio: "ignore", detached: true });
        reaper.once("error", () => { });
        reaper.unref();
        return reaper.pid;
    }
    catch {
        return undefined;
    }
}
function reapAll() { for (const c of live)
    reap(c); }
const onSignal = (signal) => {
    reapAll();
    for (const s of SIGNALS)
        process.removeListener(s, onSignal);
    // hand the signal back, now with nothing of ours listening: the default action ends the process
    process.kill(process.pid, signal);
};
function watch(c) {
    if (live.size === 0) {
        process.on("exit", reapAll);
        for (const s of SIGNALS)
            process.on(s, onSignal);
    }
    live.add(c);
}
function unwatch(c) {
    live.delete(c);
    if (live.size === 0) {
        process.removeListener("exit", reapAll);
        for (const s of SIGNALS)
            process.removeListener(s, onSignal);
    }
}
/**
 * A run that is killed outright (SIGKILL) cannot clean up: its browser is ended by the reaper
 * (startReaper), but the profile directory stays. The next capture removes those left for
 * over an hour — never a younger one, which may belong to a capture running now.
 */
export function sweepStaleProfiles(tmp = os.tmpdir(), now = Date.now()) {
    let removed = 0;
    let names;
    try {
        names = fs.readdirSync(tmp);
    }
    catch {
        return 0;
    }
    for (const name of names) {
        if (!name.startsWith("ef-share-preview-"))
            continue;
        const dir = path.join(tmp, name);
        try {
            const st = fs.lstatSync(dir);
            if (!st.isDirectory() || now - st.mtimeMs < 3_600_000)
                continue;
            fs.rmSync(dir, { recursive: true, force: true });
            removed++;
        }
        catch { /* gone, or not ours to remove */ }
    }
    return removed;
}
function runBrowser(browser, args, timeoutMs, capture) {
    return new Promise((resolve) => {
        let done = false;
        let timer;
        const finish = (v) => {
            if (done)
                return;
            done = true;
            if (timer)
                clearTimeout(timer);
            // whatever is left of the tree goes with it — a helper can outlive the process that started it
            killTree(capture.pid);
            capture.pid = undefined;
            killTree(capture.reaper);
            capture.reaper = undefined;
            resolve(v);
        };
        let child;
        try {
            child = spawn(browser, args, { stdio: "ignore", detached: process.platform !== "win32", windowsHide: true });
        }
        catch {
            finish("failed");
            return;
        }
        capture.pid = child.pid;
        capture.reaper = startReaper(child.pid, timeoutMs / 1000 + 10);
        timer = setTimeout(() => finish("timeout"), Math.max(1, timeoutMs));
        child.once("error", () => finish("failed"));
        child.once("exit", () => finish("exited"));
    });
}
/**
 * Take the picture of one result: `entry` is the page's path relative to its
 * folder, `files` everything the result publishes (the entry included).
 * Returns the picture or the reason there is none; it does not throw.
 */
export async function captureResultPreview(opts) {
    const browser = opts.browser === undefined ? findBrowser() : opts.browser;
    if (!browser)
        return { ok: false, reason: opts.browser === undefined ? whyNoBrowser() : "no browser was given" };
    const started = Date.now();
    const limit = opts.timeoutMs ?? PREVIEW.timeoutMs;
    const capture = { pid: undefined, profile: "" };
    let served = null;
    const drop = () => { try {
        fs.rmSync(opts.outFile, { force: true });
    }
    catch { /* nothing to remove */ } };
    try {
        sweepStaleProfiles();
        capture.profile = fs.mkdtempSync(path.join(os.tmpdir(), "ef-share-preview-"));
        watch(capture);
        served = await serveResultFiles(opts.files, opts.remoteHosts, opts.entry);
        fs.mkdirSync(path.dirname(opts.outFile), { recursive: true, mode: 0o700 });
        drop();
        const common = [
            // no GPU process, and software WebGL in its place: a 3D result draws the same on every machine
            "--disable-gpu", "--enable-unsafe-swiftshader",
            // Keep the framed page in the wrapper's process. Chrome gives a sandboxed frame a process of its
            // own, and the time the page is given to draw itself (--virtual-time-budget) is the top-level
            // page's: the wrapper had nothing to wait for, so the picture was taken a fraction of a second
            // into the result's run — before a 100 ms timer, before data fetched after load (verification
            // 2026-11-16, V-1). The frame is as confined as before: its sandbox and both policies are
            // unchanged, and the profile is thrown away.
            "--disable-features=IsolateSandboxedIframes",
            // the picture does not depend on whether the author's system is in dark mode
            "--blink-settings=preferredColorScheme=1",
            "--hide-scrollbars", "--mute-audio", "--no-first-run", "--no-default-browser-check",
            "--disable-extensions", "--disable-sync", "--disable-component-update",
            `--user-data-dir=${capture.profile}`, `--window-size=${PREVIEW.width},${PREVIEW.height}`,
            `--virtual-time-budget=${PREVIEW.settleMs}`, `--timeout=${PREVIEW.stopLoadingMs}`, `--screenshot=${opts.outFile}`,
        ];
        const url = `${served.origin}/${encodeURIComponent(FRAME_PATH)}`;
        // "new" headless is the one current browsers ship. An old one only knows the plain flag and
        // exits at once without a file — only then is the plain flag tried, and never after a timeout:
        // one limit covers every attempt.
        let how = "failed";
        for (const mode of ["--headless=new", "--headless"]) {
            const left = limit - (Date.now() - started);
            if (left <= 0) {
                how = "timeout";
                break;
            }
            how = await runBrowser(browser, [mode, ...common, url], left, capture);
            if (fs.existsSync(opts.outFile) || how !== "exited")
                break;
        }
        const seconds = ((Date.now() - started) / 1000).toFixed(0);
        if (!fs.existsSync(opts.outFile)) {
            return {
                ok: false,
                reason: how === "timeout" ? `the page was still not drawn after ${seconds} s` : how === "failed" ? "the browser could not be started" : "the browser did not produce a picture",
            };
        }
        let data = fs.readFileSync(opts.outFile);
        if (!pngSize(data)) {
            drop();
            return { ok: false, reason: "the browser wrote something that is not a PNG picture" };
        }
        // one flat colour says nothing about the result (a page that hangs, or draws only after a click)
        if (isFlatPng(data)) {
            drop();
            return { ok: false, reason: "the page had drawn nothing when the picture was taken" };
        }
        // a short page leaves the bottom of the window blank: those rows are cut
        let trimmed = data;
        try {
            trimmed = trimPngBottom(data, { minHeight: PREVIEW.minHeight, pad: PREVIEW.bottomMargin });
        }
        catch { /* an unusual PNG is kept as it came */ }
        // re-encoding can come out larger than the browser's own file: never lose the picture to that
        if (trimmed !== data && pngSize(trimmed) && !(trimmed.length > PREVIEW.maxBytes && data.length <= PREVIEW.maxBytes)) {
            fs.writeFileSync(opts.outFile, trimmed);
            data = trimmed;
        }
        const size = pngSize(data);
        if (data.length > PREVIEW.maxBytes) {
            drop();
            return { ok: false, reason: `the picture is ${(data.length / 1048576).toFixed(1)} MB, over the ${(PREVIEW.maxBytes / 1048576).toFixed(0)} MB a preview may be` };
        }
        if ([size.width, size.height].some((n) => n < PREVIEW.minPixels || n > PREVIEW.maxPixels)) {
            drop();
            return { ok: false, reason: `the picture is ${size.width}×${size.height} pixels; a preview is between ${PREVIEW.minPixels} and ${PREVIEW.maxPixels} a side` };
        }
        try {
            fs.chmodSync(opts.outFile, 0o600);
        }
        catch { /* a file system without modes */ }
        return { ok: true, file: opts.outFile, bytes: data.length, width: size.width, height: size.height, ms: Date.now() - started };
    }
    catch (e) {
        drop();
        return { ok: false, reason: `the picture could not be taken: ${e.message}` };
    }
    finally {
        if (served)
            await served.close().catch(() => undefined);
        if (capture.profile)
            reap(capture);
        unwatch(capture);
    }
}
