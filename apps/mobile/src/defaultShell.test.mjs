import assert from "node:assert/strict";
import test from "node:test";
import { effectiveDefaultShell } from "./defaultShell.ts";

test("a live default shell id is shown unchanged", () => {
  assert.equal(
    effectiveDefaultShell([{ id: "powershell" }, { id: "cmd" }], "powershell"),
    "powershell"
  );
  assert.equal(
    effectiveDefaultShell([{ id: "powershell" }, { id: "cmd" }], "cmd"),
    "cmd"
  );
});

test("a stale default falls back to the first shell the desktop still offers", () => {
  assert.equal(
    effectiveDefaultShell([{ id: "powershell" }, { id: "cmd" }], "removed-profile"),
    "powershell"
  );
});

test("a valid default wins over the first shell when it is not first", () => {
  assert.equal(
    effectiveDefaultShell([{ id: "powershell" }, { id: "git-bash" }], "git-bash"),
    "git-bash"
  );
});

test("an empty default id is replaced by the first shell", () => {
  assert.equal(effectiveDefaultShell([{ id: "cmd" }], ""), "cmd");
});

test("an empty shell list yields an empty selection", () => {
  assert.equal(effectiveDefaultShell([], "cmd"), "");
  assert.equal(effectiveDefaultShell([], ""), "");
});

test("a duplicate shell id that is also the default stays selected", () => {
  assert.equal(
    effectiveDefaultShell([{ id: "cmd" }, { id: "cmd" }, { id: "powershell" }], "cmd"),
    "cmd"
  );
});

test("malformed shell entries with missing or blank ids never fill the selection", () => {
  // A snapshot from an older desktop could carry entries with no id; the
  // picker must fall back to its empty state rather than rendering "" as a
  // choice or crashing on undefined.
  assert.equal(effectiveDefaultShell([{}], "cmd"), "");
  assert.equal(effectiveDefaultShell([{ id: undefined }, { id: "powershell" }], "cmd"), "powershell");
  assert.equal(effectiveDefaultShell([{ id: "" }, { id: "powershell" }], "cmd"), "powershell");
  assert.equal(effectiveDefaultShell([{}], ""), "");
});

test("duplicate shell ids cannot produce a selection missing from the list", () => {
  assert.equal(effectiveDefaultShell([{ id: "cmd" }, { id: "cmd" }], "cmd"), "cmd");
  assert.equal(
    effectiveDefaultShell([{ id: "cmd" }, { id: "powershell" }, { id: "powershell" }], "powershell"),
    "powershell"
  );
});
