import { createServer } from "node:http";
import { randomBytes, createHash } from "node:crypto";
import { writeCredentials } from "../src/lib/credentials.js";
import { openUrl as defaultOpen } from "../src/lib/open-url.js";
const CLIENT_ID = "ef-share-cli";
function generatePkce() {
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    return { verifier, challenge };
}
export async function performLogin(opts) {
    const open = opts.openBrowser ?? defaultOpen;
    const writeCreds = opts.writeCreds ?? writeCredentials;
    const log = opts.log ?? ((m) => process.stdout.write(m + "\n"));
    const { verifier, challenge } = generatePkce();
    const state = randomBytes(16).toString("base64url");
    const result = await new Promise((resolve, reject) => {
        const server = createServer((req, res) => {
            const port = server.address().port;
            const url = new URL(req.url, `http://localhost:${port}`);
            if (url.pathname !== "/cb") {
                res.writeHead(404).end();
                return;
            }
            if (url.searchParams.get("state") !== state) {
                res.writeHead(400).end("Invalid state");
                server.close();
                reject(new Error("state mismatch"));
                return;
            }
            const errorParam = url.searchParams.get("error");
            if (errorParam) {
                res.writeHead(400).end(`Error: ${errorParam}`);
                server.close();
                reject(new Error(errorParam));
                return;
            }
            const code = url.searchParams.get("code");
            if (!code) {
                res.writeHead(400).end();
                server.close();
                reject(new Error("no code"));
                return;
            }
            res.writeHead(200, { "Content-Type": "text/html" }).end("<h1>Logged in. You can close this window.</h1>");
            server.close();
            resolve({ port, code });
        });
        server.listen(0, "127.0.0.1", () => {
            const port = server.address().port;
            const redirectUri = `http://127.0.0.1:${port}/cb`;
            const authUrl = new URL(`${opts.authServerUrl}/oauth/authorize`);
            authUrl.searchParams.set("response_type", "code");
            authUrl.searchParams.set("client_id", CLIENT_ID);
            authUrl.searchParams.set("redirect_uri", redirectUri);
            authUrl.searchParams.set("code_challenge", challenge);
            authUrl.searchParams.set("code_challenge_method", "S256");
            authUrl.searchParams.set("state", state);
            authUrl.searchParams.set("scope", "openid profile share:publish");
            open(authUrl.toString());
            log(`Waiting for browser login: ${authUrl.toString()}`);
        });
        setTimeout(() => { server.close(); reject(new Error("timeout")); }, 10 * 60 * 1000);
    });
    const tokenRes = await fetch(`${opts.authServerUrl}/oauth/token`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
            grant_type: "authorization_code",
            code: result.code,
            redirect_uri: `http://127.0.0.1:${result.port}/cb`,
            client_id: CLIENT_ID,
            code_verifier: verifier,
        }),
    });
    if (!tokenRes.ok)
        throw new Error(`Token exchange failed: ${tokenRes.status} ${await tokenRes.text()}`);
    const tokens = await tokenRes.json();
    await writeCreds({
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token ?? null,
        expires_at: Date.now() + tokens.expires_in * 1000,
        auth_server: opts.authServerUrl,
        api_server: opts.apiServerUrl,
    });
    log("Logged in. Token saved to ~/.config/ef-share/credentials.json.");
}
async function main() {
    const argv = process.argv.slice(2);
    if (argv[0] !== "login") {
        process.stderr.write("Usage: ef-share login [--auth-server <url>] [--api-server <url>]\n");
        process.exit(2);
    }
    const flag = (name, defValue) => {
        const i = argv.indexOf(`--${name}`);
        return i >= 0 && argv[i + 1] ? argv[i + 1] : defValue;
    };
    const authServerUrl = flag("auth-server", process.env.EF_SHARE_AUTH_SERVER ?? "https://auth.elasticflow.app");
    const apiServerUrl = flag("api-server", process.env.EF_SHARE_API_SERVER ?? "https://share.elasticflow.app");
    try {
        await performLogin({ authServerUrl, apiServerUrl });
    }
    catch (err) {
        process.stderr.write(`Error: ${err.message}\n`);
        process.exit(1);
    }
}
if (process.argv[1]?.endsWith("ef-share.js") || process.argv[1]?.endsWith("ef-share")) {
    main();
}
