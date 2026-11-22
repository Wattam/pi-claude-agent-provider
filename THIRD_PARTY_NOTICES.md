# Third-party notices

Original code is licensed under 0BSD. Code adapted from OpenCode remains under MIT. Pi peers are host-provided and are not bundled.

## OpenCode source

Repository: https://github.com/anomalyco/opencode
Commit: `805a42ffaa56b29a88baef87c7567f1ab9a40a8f`.

Adapted files under `packages/core/src/plugin/provider/claude-agent/`:

- `claude/session.ts`
- `claude/query-options.ts`
- `claude/probe.ts`
- `tools/names.ts`
- `tools/pending.ts`
- `tools/server.ts`
- `tools/hooks.ts`
- `language-model/convert-claude-stream.ts`
- `language-model/usage.ts`
- `language-model/claude-agent-error.ts`
- `sync/catch-up.ts`
- `sync/fingerprint.ts`

MIT License

Copyright (c) 2025 opencode

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## Claude Agent SDK

`@anthropic-ai/claude-agent-sdk` is an npm dependency installed separately by `npm install`. It is not bundled with this package. Its use is governed by Anthropic's terms stated in its `README.md`.
