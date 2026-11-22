import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default async function (pi: ExtensionAPI): Promise<void> {
    if (process.platform !== "linux") return;

    const { registerClaudeAgent } = await import("./src/extension.js");
    registerClaudeAgent(pi);
}
