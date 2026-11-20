// packages/ef-share-plugin/src/lib/cli-args.ts
//
// The argument grammar of `ef-share-session`, in ONE place.
//
// Two programs read the same command line: the tool itself (bin/session-cli.ts)
// and the PreToolUse hook that decides whether to approve it without a prompt
// (src/hooks/pre-tool-use.ts). When each had its own reading, they disagreed:
// the hook looked at the FIRST `--results`, the tool used the LAST, so
// `--results none --results 1` was approved as "no result files" and then
// uploaded result 1 (review 2026-11-16, P-2). Both now call parseCommandArgs,
// and the grammar has no room for a second reading: an option that takes one
// value may be given once, an unknown option is an error.
/** The caller can fix this (exit code 2); the message says what. */
export class UsageError extends Error {
}
export const COMMAND_SPECS = {
    prepare: { single: ["transcript", "out"], repeat: ["result"], positional: 0 },
    show: { single: ["dir"], repeat: [], positional: 1 },
    upload: { single: ["dir", "url", "ticket", "results", "pictures"], repeat: [], positional: 0 },
};
export const USAGE = "usage: ef-share-session prepare|show|upload … (see commands/share.md)";
export function parseCommandArgs(command, argv) {
    const spec = command ? COMMAND_SPECS[command] : undefined;
    if (!command || !spec)
        throw new UsageError(USAGE);
    const flags = new Map();
    const positional = [];
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (!a.startsWith("--")) {
            positional.push(a);
            if (positional.length > spec.positional)
                throw new UsageError(`${command}: unexpected argument "${a}"`);
            continue;
        }
        const eq = a.indexOf("=");
        const name = eq > 0 ? a.slice(2, eq) : a.slice(2);
        const isSingle = spec.single.includes(name);
        if (!isSingle && !spec.repeat.includes(name))
            throw new UsageError(`${command}: unknown option --${name}`);
        let value;
        if (eq > 0)
            value = a.slice(eq + 1);
        else {
            value = argv[++i];
            // `--out --transcript x` would make "--transcript" the value of --out
            if (value !== undefined && value.startsWith("--"))
                throw new UsageError(`--${name} needs a value (write --${name}=<value> if the value starts with "--")`);
        }
        if (value === undefined || value === "")
            throw new UsageError(`--${name} needs a value`);
        if (isSingle && flags.has(name))
            throw new UsageError(`--${name} was given more than once`);
        flags.set(name, [...(flags.get(name) ?? []), value]);
    }
    return { flags, positional };
}
export function flag(args, name) {
    return args.flags.get(name)?.[0];
}
