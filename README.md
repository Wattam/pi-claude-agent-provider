# Claude Agent provider for Pi

Registers the Pi provider `claude-agent` (display name `Claude Agent`, API id `claude-agent-sdk`). Requests run through the locally installed Claude Code CLI with `@anthropic-ai/claude-agent-sdk`. Pi keeps its own prompt, tools, transcript, and tool execution. Claude Code receives Pi's tools through a private in-process MCP server named `pi`.

## Requirements

- Linux. The provider does not register on other operating systems. macOS support is unverified.
- Claude Code (`claude`) 2.1.317 or later on `PATH`. The provider blocks a Pi tool call whose `PreToolUse` hook callback failed, which needs that release. Verified against Pi 1.6.0, Claude Code 2.1.329, and Agent SDK 0.3.329.
- Claude Code logged in with the Claude subscription login: `claude auth login`.
- Node.js 22.19.0 or later.

## Install

```sh
pi install git:github.com/Wattam/pi-claude-agent-provider
```

The provider runs the `claude` found on `PATH`. Run `/reload` in Pi after installing.

## Model discovery

Interactive and RPC Pi refresh the catalog in the background. Discovery starts Claude Code without a transcript, reads the login's explicit models and their context windows, and submits no inference prompt. Print and JSON modes use the persisted catalog in `models-store.json`. Discovered models are not auto-enabled. Enable them through `/scoped-models`.

## Metadata fallbacks

| Field          | Value                                                                      |
|----------------|----------------------------------------------------------------------------|
| Context window | Claude Code's reported `rawMaxTokens`; 200000 when none is reported        |
| Output limit   | 32000 for every model; the SDK reports no output limit                     |
| Cost           | 0; usage is covered by the subscription, so no API-price estimate is shown |

## Thinking levels

Each model exposes only its reported `supportedEffortLevels` (`low`, `medium`, `high`, `xhigh`, `max`). The selected Pi thinking level becomes the SDK effort. `off` and `minimal` are unsupported on reasoning models. A model without effort levels runs with thinking disabled.

## Extra-usage policy

The provider does not look up the paid-usage (`extra_usage`) setting before a request. Requests run on the subscription quota whether extra usage is enabled or not.

During a request, Claude Code reports rate-limit status. When a report shows extra usage credits in use (`isUsingOverage` or `overageInUse`), the provider:

1. Interrupts the request, stops the Claude Code process, and fails the chat turn with this error:
   > Claude Agent stopped this chat: Claude reported that this request uses extra usage credits because the subscription quota is used up. Claude Agent never relies on paid billing. Requests for this Claude account are blocked until the quota resets at \<time\>.
2. Shows this warning. TUI and RPC modes show a Pi warning notification. Print and JSON modes write it to stderr.
   > Claude Agent: a request drew on extra usage credits before it could be stopped and may be billed. Disable extra usage for this Claude account or organization to prevent any paid usage.
3. Blocks later requests for that account and organization before Claude Code starts, in every session of the Pi process, including after `/reload`. The block ends when the reported subscription window resets. Without a reported reset time it ends when Pi restarts.

Rate-limit observation stays active while Pi executes tools and while an interrupted turn drains, including during cancellation, agent settlement, and shutdown. The first report of extra usage triggers interruption and process shutdown immediately, records a failed continuation checkpoint, warns once, and blocks the account even if the Pi stream already ended at a tool boundary. If additional user input may remain queued, the provider kills the Claude Code child immediately without waiting for the interrupt receipt or result: plain interruption preserves queued prompts, and SDK close allows an EOF grace period. Otherwise, the provider drains the interrupted turn for late rate-limit reports. If Claude rejects the interrupt or does not acknowledge and drain it within five seconds, the provider closes the process instead of waiting indefinitely.

The provider tracks each subscription window reported as exhausted through extra usage in use, rejected status, or utilization of at least 100%. Requests stay blocked until the latest reset of those exhausted windows. Resets from non-exhausted windows cannot end the block. Reports before detection or during interruption can supply missing reset data for the same exhausted window without another interrupt. A report with `rateLimitType: "overage"` describes the extra-usage window, not a subscription reset; its reset time and unnamed resets are ignored. Missing reset data cannot erase a known reset for the same window. If any identified exhausted window has no reported reset, or no exhausted subscription window is identified, the block lasts until Pi restarts.

The report arrives after Claude accepted the request, so the stopped request may already be billed. Disabling extra usage account-side is the only way to prevent any paid usage. Pi's `warnings.anthropicExtraUsage` setting has no effect on this policy.

## State and privacy

Continuation state is stored as `claude-agent-state` custom entries in the Pi session. Each entry holds the Claude session id, conversation checkpoints, and a SHA-256 digest of the login's account and organization. No email, organization name, organization id, or prompt text is stored. Claude transcripts stay in Claude Code's own project storage. The provider reads no saved credentials. The Claude child process gets an environment without `ANTHROPIC_*` variables and without cloud or gateway routing variables; Pi's own environment is not changed.

## Transcript write failures

When Claude Code reports that it could not save transcript lines (a full disk or a used-up quota), the provider warns and refuses to resume that Claude session: the next request in the chat fails with an error naming `/new`. The report arrives as the Claude Code process exits, so the refusal lasts for the life of the Pi process; a Pi restart forgets it.

## Limitations

- No provider handoff: a chat with history from another provider cannot continue on Claude Agent, and a Claude Agent chat cannot be handed back after another provider replied.
- Forked and cloned sessions, `/tree` navigation to an earlier branch, and edited history fail with an error that names `/new`.
- Compaction, automatic session naming, cache warming, and other standalone model calls are not supported.
- `after_provider_response` is not emitted.
- A changed system prompt or tool set restarts the Claude Code process on the same Claude session.
- On Claude Code 2.1.328 or later, the provider disables automatic resumption of tool calls deferred by a Claude Code hook. Pi owns tool execution.
- Live cache tests consume subscription quota and need explicit authorization.

## Development

Run from the repository root:

```sh
npm ci
npm run link:host
npm run typecheck
npm test
```

For a checkout outside the managed Pi extensions directory, set `PI_HOST_NODE_MODULES` to your Pi release's `node_modules` directory before linking. Refresh the links after updating Pi.

The repository's `.npmrc` skips the SDK's optional binaries and Pi's host peer dependencies during development installs.
