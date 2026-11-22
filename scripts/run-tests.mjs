import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export async function runTests(kind) {
    if (!["all", "unit", "integration"].includes(kind)) throw new Error("Invalid suite: all, unit, or integration");
    const paths = [];
    for (const type of kind === "all" ? ["unit", "integration"] : [kind]) {
        const selected = [];
        async function discover(path) {
            const entries = await readdir(path, { withFileTypes: true }).catch((error) => {
                if (error.code === "ENOENT") return [];
                throw error;
            });
            for (const entry of entries) {
                const child = join(path, entry.name);
                if (entry.isDirectory()) await discover(child);
                else if (entry.isFile() && entry.name.endsWith(".test.js")) selected.push(child);
            }
        }
        await discover(join(root, "dist-test", "test", type));
        if (!selected.length) throw new Error(`No test files in ${type} suite`);
        paths.push(...selected);
    }
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    delete env.NODE_OPTIONS;
    delete env.NODE_PATH;
    const child = spawn(process.execPath, ["--test", ...paths.sort()], { stdio: "inherit", env });
    const code = await new Promise((resolveExit, reject) => {
        child.once("error", reject);
        child.once("exit", (status, signal) => resolveExit(status ?? (signal ? 1 : 0)));
    });
    return code;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    process.exitCode = await runTests(process.argv[2]);
}
