import { cleanPlanTitle } from "./state.ts";

const IMPLEMENTATION_HEADING = /^##\s+Implementation Steps\s*$/i;
const NEXT_H2 = /^##\s+/;
const STEP = /^\s*\d+\.\s+(\S.*?)\s*$/;

export interface PlanDocumentSummary {
	title: string;
	steps: string[];
}

/** Validate the lightweight plan headings and return a displayable summary. */
export function inspectPlanMarkdown(markdown: string): PlanDocumentSummary {
	if (!markdown.trim()) throw new Error("A saved plan cannot be empty");
	const lines = markdown.split(/\r?\n/);
	let inFence = false;
	let title = "";
	let inSteps = false;
	const steps: string[] = [];
	for (const line of lines) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (inFence) continue;
		const heading = /^\s*#\s+(.+?)\s*#*\s*$/.exec(line);
		if (!title && heading) title = cleanPlanTitle(heading[1]!);
		if (IMPLEMENTATION_HEADING.test(line.trim())) {
			inSteps = true;
			continue;
		}
		if (inSteps && NEXT_H2.test(line.trim())) {
			inSteps = false;
			continue;
		}
		if (inSteps) {
			const match = STEP.exec(line);
			if (match) steps.push(match[1]!.trim());
		}
	}
	if (!title) throw new Error("A saved plan needs a top-level title");
	if (!/^##\s+Verification\s*$/im.test(markdown)) throw new Error("A saved plan needs a ## Verification section");
	if (!/^##\s+Implementation Steps\s*$/im.test(markdown) || steps.length === 0) {
		throw new Error("A saved plan needs numbered steps under ## Implementation Steps");
	}
	return { title, steps };
}

export function createPlanTemplate(title: string): string {
	return `# ${cleanPlanTitle(title)}\n\n## Goal\n\nDescribe the intended outcome.\n\n## Scope\n\nDescribe what is included and any important boundaries.\n\n## Verification\n\n**Agent**\n\n- Add the smallest focused check and its expected result.\n\n## Implementation Steps\n1. Describe the first discrete work unit.\n`;
}
