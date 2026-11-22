import type { EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import {
    createAssistantMessageEventStream, getCurrentSystemPrompt, getCurrentTools, type Api,
    type AssistantMessageEventStream, type Model, type Provider, type SimpleStreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import { discoverCatalog, restoreStored, toPiModel } from "./catalog.js";
import { API_ID, AUTH_SOURCE, MODEL_BASE_URL, PROVIDER_ID, PROVIDER_NAME } from "./constants.js";
import { childEnv, type ClaudeIO } from "./io.js";
import { STANDALONE } from "./messages.js";
import { withProbe } from "./probe.js";
import type { SessionRuntime } from "./session-runtime.js";
import { PiStreamWriter } from "./stream-writer.js";
import { conversationMessages } from "./transcript.js";
import { errorMessage } from "./values.js";

export interface ActiveSession {
    piSessionId: string;
    runtime: SessionRuntime;
}

export interface ProviderDeps {
    io: ClaudeIO;
    getActive(): ActiveSession | undefined;
}

/**
 * Streams one request of the active Pi chat through its session runtime. Every other caller (session naming,
 * summaries, cache warming) is a standalone call and fails without starting Claude Code. Pi's API key, headers,
 * environment, token limit, temperature, and cache retention options are ignored.
 */
function streamClaudeAgent(
    deps: ProviderDeps,
    model: Model<Api>,
    context: TranscriptContext,
    options: SimpleStreamOptions | undefined,
): AssistantMessageEventStream {
    const stream = createAssistantMessageEventStream();
    const level = options?.reasoning ? model.thinkingLevelMap?.[options.reasoning] ?? undefined : undefined;
    const effort = level as EffortLevel | undefined;
    const writer = new PiStreamWriter(model, stream, effort);
    void (async () => {
        const active = deps.getActive();
        if (!active || options?.sessionId !== active.piSessionId) {
            writer.fail("error", STANDALONE);
            return;
        }
        try {
            await active.runtime.run({
                model,
                effort,
                thinking: model.reasoning ? "adaptive" : "disabled",
                systemPrompt: getCurrentSystemPrompt(context.messages),
                tools: options?.toolChoice === "none" ? [] : getCurrentTools(context.messages),
                conversation: conversationMessages(context.messages),
                signal: options?.signal,
                onPayload: options?.onPayload,
                onProviderStreamEvent: options?.onProviderStreamEvent,
            }, writer);
        } catch (error) {
            writer.fail("error", errorMessage(error));
        }
    })();
    return stream;
}

export function createClaudeAgentProvider(deps: ProviderDeps): Provider<typeof API_ID> {
    let models: Model<typeof API_ID>[] = [];
    return {
        id: PROVIDER_ID,
        name: PROVIDER_NAME,
        baseUrl: MODEL_BASE_URL,
        // Claude Code owns the login; Pi supplies no credential and offers no separate login flow.
        auth: {
            apiKey: {
                name: "Claude Code login (claude auth login)",
                check: async () => ({ type: "api_key", source: AUTH_SOURCE }),
                resolve: async () => ({ auth: {}, source: AUTH_SOURCE }),
            },
        },
        getModels: () => models,
        async refreshModels(context) {
            const restored = restoreStored(context.stored);
            if (restored.length > 0 && !await context.publish({ update: () => { models = restored; } })) return;
            if (!context.allowNetwork || context.signal.aborted) return;
            const executable = deps.io.which();
            if (!executable) return;
            const entries = await withProbe(deps.io, executable, childEnv(deps.io.env()), context.signal,
                probe => discoverCatalog(probe, context.signal));
            if (context.signal.aborted) return;
            const next = entries.map(toPiModel);
            await context.publish({ persist: { models: next, checkedAt: Date.now() }, update: () => { models = next; } });
        },
        stream: (model, context, options) =>
            streamClaudeAgent(deps, model, context, options as SimpleStreamOptions | undefined),
        streamSimple: (model, context, options) => streamClaudeAgent(deps, model, context, options),
    };
}
