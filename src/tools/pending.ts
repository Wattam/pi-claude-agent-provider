import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { deferred, type Deferred } from "../async.js";

export interface PendingTools {
    expect(id: string, sdkName: string): void;
    /** PreToolUse hook: the next MCP call belongs to this tool-use id. */
    before(id: string, sdkName: string): void;
    /** MCP tools/call handler: waits for Pi's result of the call announced by `before`. */
    call(sdkName: string): Promise<CallToolResult>;
    resolve(id: string, result: CallToolResult): void;
    /**
     * Cancels every waiting call. Call only after interrupt-and-drain; earlier resolution can start another model
     * call.
     */
    clear(): void;
}

interface Call {
    readonly name: string;
    readonly result: Deferred<CallToolResult>;
}

const CANCELLED: CallToolResult = { isError: true, content: [{ type: "text", text: "Cancelled by user." }] };

export function createPendingTools(): PendingTools {
    const calls = new Map<string, Call>();
    let next: string | undefined;

    function expect(id: string, sdkName: string): Call {
        const saved = calls.get(id);
        const call = saved ?? { name: sdkName, result: deferred<CallToolResult>() };
        if (!saved) calls.set(id, call);
        if (call.name !== sdkName) throw new Error(`Mismatched Claude tool call ${id}`);
        return call;
    }

    return {
        expect(id, sdkName) {
            expect(id, sdkName);
        },
        before(id, sdkName) {
            expect(id, sdkName);
            next = id;
        },
        async call(sdkName) {
            const id = next;
            next = undefined;
            if (!id) throw new Error("Claude invoked a Pi tool without its PreToolUse ID");
            const result = await expect(id, sdkName).result.promise;
            calls.delete(id);
            return result;
        },
        resolve(id, result) {
            const call = calls.get(id);
            if (!call) throw new Error(`No waiting Claude tool call ${id}`);
            call.result.resolve(result);
        },
        clear() {
            for (const call of calls.values()) call.result.resolve(CANCELLED);
            calls.clear();
            next = undefined;
        },
    };
}
