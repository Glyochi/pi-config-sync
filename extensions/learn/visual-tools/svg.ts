import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerVisualTools } from "./common.ts";

export default function svgTools(pi: ExtensionAPI): void {
	registerVisualTools(pi, "svg");
}
