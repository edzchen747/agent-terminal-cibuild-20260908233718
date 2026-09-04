import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyStoredTheme } from "./theme";
import "./fonts.css";
import "./styles.css";

// Paint the saved theme before the first render so a light-mode launch never
// flashes the dark palette behind the splash.
applyStoredTheme();

console.log("[ATSync] app boot");

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

