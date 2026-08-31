import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Regression guard for the commit b2f7def "tap bleed" fix: a document-level
// click-swallow useEffect was appended after App's early returns. Renders that
// return early (Splash, PairScreen, HostsPage, ErrorScreen, `null`) then run
// fewer hooks than the full-pager render, so React throws (#310) and the whole
// tree unmounts — a blank screen after pairing or any reconnect.
//
// The invariant this test pins: inside App, every top-level hook call must
// appear before the first top-level `if`/return guard. A hook added after the
// guards fails here instead of blanking the phone.

const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
const lines = source.split("\n");

// The App component body: from `export function App()` to the next top-level
// function declaration.
const start = lines.findIndex((line) => /^export function App\(/.test(line));
const endIndex = lines.findIndex((line, index) => index > start && /^function \w/.test(line));

test("App runs every hook before its first early-return guard", () => {
  assert.notEqual(start, -1, "App component not found (did the source drift?)");
  assert.notEqual(endIndex, -1, "end of App component not found (did the source drift?)");
  const body = lines.slice(start, endIndex);

  // Top-level (2-space indented) hook calls: `const [x, setX] = useState<T>(…)`
  // or `useEffect(() => {…}, []);` (the `(<` covers `useRef<T>(…)` generics).
  const hookLines = body
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /^ {2}(?:const .* = )?use[A-Z]\w*[<(]/.test(line));
  assert.ok(hookLines.length > 0, "no top-level hooks found in App (did the scan drift?)");

  // The first top-level control-flow guard; the early returns live under it.
  const firstGuard = body
    .map((line, index) => ({ line, index }))
    .find(({ line }) => /^ {2}if \(/.test(line));
  assert.ok(firstGuard, "no top-level guard found in App (did the scan drift?)");

  assert.ok(
    hookLines.at(-1).index < firstGuard.index,
    `App calls a hook after its first early-return guard: last hook at source line ` +
      `${start + hookLines.at(-1).index + 1} (${hookLines.at(-1).line.trim()}) but the first guard is at source line ` +
      `${start + firstGuard.index + 1} (${firstGuard.line.trim()}). Every hook must run in every render, ` +
      "so hooks must stay above every early return.",
  );
});
