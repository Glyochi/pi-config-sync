import type { Mode, PlanStateView } from "./state.ts";

export function buildModeContext(mode: Mode, plan?: { view: PlanStateView; markdown: string }, stalePlan = false): string {
	if (mode === "ask") {
		return `Ask mode is for learning, explanations, and research. Treat each question independently; do not inject or assume the attached plan unless the user explicitly refers to it. Inspect the local repository and documentation for codebase questions. Use available web/search/MCP sources when current or external facts matter, and cite sources. Choose a useful visualization format for the topic; when an artifact helps, save it under the project-local ask_tools/ folder and report its path. Do not execute generated scripts, launch a server, or open artifacts unless the user asks. The existing Build-level tools and permissions remain available, so honor explicit project-code requests. If the user requests a formal saved implementation plan, tell them to switch to /plan; do not create or write it in Ask mode. Never edit files under .pi/plans/ from Ask mode.`;
	}

	if (mode === "plan") {
		const current = stalePlan
			? "The attached plan is owned by another session. Do not revise it or update its status; use /plan resume <id> to claim it first."
			: plan?.view.status === "blocked"
				? `Plan ${plan.view.id} is blocked: ${plan.view.blockedReason ?? "no reason recorded"}. Use /plan resume ${plan.view.id} to reopen it before revising.`
				: plan?.view.status === "completed"
					? `The attached plan ${plan.view.id} is completed. Use /plan new <title> to start another saved plan.`
					: plan
						? `Current plan: ${plan.view.id} · ${plan.view.title} · ${plan.view.status}\nPlan Markdown (the only project file Plan mode may edit): ${plan.view.path}\n\n${plan.markdown}`
						: "No plan is attached. A formal saved plan is created only when the user requests one; use plan_create and then write the complete document to the returned canonical path.";
		return `Plan mode is read-only for project work. You may inspect and discuss files, and may create or revise only the attached canonical plan Markdown in .pi/plans/. Do not edit application/source files or run shell commands that mutate the project. Do not execute implementation steps or start Build automatically. Use a concise plan with Goal/Scope, ## Verification, and numbered ## Implementation Steps. When the user explicitly switches to Build, the next user request controls whether implementation proceeds.\n\n${current}`;
	}

	if (stalePlan) {
		return "Build mode has normal Build-level permissions, but the attached plan is now owned by another session. Do not mutate plan state or any .pi/plans/ Markdown file based on that stale attachment. Use /plan resume <id> to claim it, or continue with unrelated explicit user work.";
	}
	if (plan?.view.status === "blocked") {
		return `Build mode has normal Build-level permissions, but plan ${plan.view.id} is blocked: ${plan.view.blockedReason ?? "no reason recorded"}. Do not continue its planned work until the user explicitly resumes it with /plan resume ${plan.view.id}. Unrelated explicit Build requests remain available.`;
	}
	if (plan?.view.status === "completed") plan = undefined;
	if (!plan) {
		return "Build mode allows ordinary coding and discussion under the permissions extension's Build policy. Ask before expanding a requested task into unrelated work. Plan Markdown under .pi/plans/ is extension-owned and must not be edited in Build mode.";
	}
	return `Build mode allows implementation under the permissions extension's Build policy. The user switched from Plan to Build; this authorizes work on the attached plan when the next user request asks to continue, but mode switching alone does not start a turn. Follow the saved plan and its Verification section. Do not edit .pi/plans/ Markdown; use the structured plan status tool for completion/blockage.\n\nActive plan ${plan.view.id}: ${plan.view.title}\nStatus: ${plan.view.status}\nPlan file: ${plan.view.path}\n\n${plan.markdown}`;
}
