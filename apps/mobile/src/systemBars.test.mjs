import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import "./test-support.mjs";

// Node has no native bridge, so Capacitor reports the web platform and the
// system-bar sync must no-op instead of hanging or throwing.
const { syncSystemBars } = await import("./systemBars.ts");

test("off device (web platform) syncing the system bars is a no-op", async () => {
  await syncSystemBars("light");
  await syncSystemBars("dark");
});

test("an unavailable native implementation resolves instead of rejecting", async () => {
  // Capacitor's web stub rejects with "not available for web"; an older APK
  // behaves the same way. Neither may break theme switching in the web layer.
  const { Capacitor } = await import("@capacitor/core");
  const original = Capacitor.isNativePlatform.bind(Capacitor);
  Capacitor.isNativePlatform = () => true;
  try {
    await syncSystemBars("light");
    await syncSystemBars("dark");
  } finally {
    Capacitor.isNativePlatform = original;
  }
});

test("the bar style is Capacitor's, and follows its content-naming inversion", () => {
  // Capacitor names the style after the bar *content*, so the light app theme
  // maps to Light (dark content on a light background). Getting this backwards
  // is exactly the bug being fixed, and is invisible in a web build.
  const source = readFileSync(fileURLToPath(new URL("./systemBars.ts", import.meta.url)), "utf8");
  assert.match(source, /SystemBarsStyle\.Light : SystemBarsStyle\.Dark/);
  assert.match(source, /theme === "light" \?/);
});

test("no custom native plugin shadows Capacitor's built-in SystemBars", () => {
  // registerPlugin("SystemBars") is refused because Capacitor core already
  // owns that name, and the caller silently gets its web stub instead.
  const source = readFileSync(fileURLToPath(new URL("./systemBars.ts", import.meta.url)), "utf8");
  assert.ok(!source.includes("registerPlugin"), "must use Capacitor's SystemBars rather than registering one");
  const activity = readFileSync(
    fileURLToPath(new URL("../android/app/src/main/java/com/agentterminal/mobile/MainActivity.java", import.meta.url)),
    "utf8"
  );
  assert.ok(!activity.includes("SystemBarsPlugin"), "no custom SystemBars plugin should be registered");
});

test("the mobile app syncs the bars whenever its resolved theme changes", () => {
  // The bars are only correct if this runs on every theme change, including
  // the OS flipping while "system" is the selected preference.
  const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
  assert.match(app, /void syncSystemBars\(resolvedTheme\);/);
  assert.match(app, /\}, \[themePreference, resolvedTheme\]\);/);
});
