import assert from "node:assert/strict";
import test from "node:test";
import { MIN_CLAUDE_CODE_VERSION } from "../../src/constants.js";
import { tooOld } from "../../src/messages.js";
import { atLeast, versionError } from "../../src/version.js";

test("version comparison uses numeric dot-separated parts and ignores pre-release or build suffixes", () => {
    assert.equal(atLeast("2.1.316", "2.1.316"), true);
    assert.equal(atLeast("2.1.1000", "2.1.316"), true);
    assert.equal(atLeast("2.2.0", "2.1.316"), true);
    assert.equal(atLeast("3.0.0", "2.1.316"), true);
    assert.equal(atLeast("2.1.315", "2.1.316"), false);
    assert.equal(atLeast("2.0.999", "2.1.316"), false);
    assert.equal(atLeast("2.1.316-beta.1", "2.1.316"), true);
    assert.equal(atLeast("2.1.316+build.5", "2.1.316"), true);
});

test("an old or unreported Claude Code version produces the update diagnostic", () => {
    assert.equal(versionError(MIN_CLAUDE_CODE_VERSION), undefined);
    assert.equal(versionError("2.1.316"), tooOld("2.1.316"));
    assert.equal(versionError(undefined), tooOld(undefined));
    assert.match(tooOld(undefined), /\(unknown version\).*2\.1\.317 or later.*claude update/);
});
