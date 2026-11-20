// packages/ef-share-plugin/src/lib/limits.ts
//
// The size rules of one upload, shared by the step that prepares it and the
// step that sends it — so the number the person is told is the number that is
// sent (review 2026-11-16, P-3: prepare counted the main transcript compressed,
// upload sent it plain, and neither counted the results).
/** Up to this size the main transcript goes uncompressed, which every server version reads. */
export const PLAIN_TRANSCRIPT_MAX = 8 * 1024 * 1024;
/** Largest request body the publish endpoint is known to take (prod nginx: 25M), with headroom. */
export const DEFAULT_UPLOAD_BUDGET = 22 * 1024 * 1024;
/** Multipart framing per part (boundary, disposition, content type), rounded up. */
export const PART_OVERHEAD_BYTES = 200;
/**
 * The budget in force. `EF_SHARE_UPLOAD_BUDGET_BYTES` overrides it for an
 * endpoint that is known to take more (or less) than production does.
 */
export function uploadBudget(env = process.env) {
    const raw = env["EF_SHARE_UPLOAD_BUDGET_BYTES"];
    if (raw && /^\d{1,12}$/.test(raw) && Number(raw) > 0)
        return Number(raw);
    return DEFAULT_UPLOAD_BUDGET;
}
/**
 * What the server takes of the transcripts once decompressed
 * (viewer/lib/uploads/staged-upload.ts UPLOAD_LIMITS). A sub-agent transcript
 * compresses well, so one that fits the request budget can still be over these.
 */
export const SERVER_LIMITS = {
    transcriptBytes: 256 * 1024 * 1024,
    subagentBytes: 96 * 1024 * 1024,
    subagentTotalBytes: 384 * 1024 * 1024,
};
export const mb = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
