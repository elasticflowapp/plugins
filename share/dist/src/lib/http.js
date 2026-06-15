import { readCredentials } from "./credentials.js";
export async function authedFetch(input, init = {}) {
    const creds = await readCredentials();
    if (!creds)
        throw new Error("Not logged in. Run `ef-share login` first.");
    const url = input.startsWith("http") ? input : creds.api_server + input;
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${creds.access_token}`);
    return fetch(url, { ...init, headers });
}
