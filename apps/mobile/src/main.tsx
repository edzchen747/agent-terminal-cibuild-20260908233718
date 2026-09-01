import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./fonts.css";
import "./styles.css";

console.log("[ATSync] app boot");

createRoot(document.getElementById("root")!).render(<StrictMode><App /></StrictMode>);

