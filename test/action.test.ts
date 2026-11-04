import { describe, expect, it } from "vitest";
import { decodeState, renderPlan, type PlanState } from "../src/comment.js";
import { durationInDays, parseEpicBody } from "../src/epic.js";
import { applyPlan, refreshFromGitHub, type Octokit } from "../src/github.js";
import { parseCommand } from "../src/main.js";
import { finalizePlan, finalizeReplan } from "../src/plan.js";
import type { LlmTask, StoredTask, TeamMember } from "../src/schema.js";

const llmTask = (ref: string, extra: Partial<LlmTask> = {}): LlmTask => ({
  ref, title: `Task ${ref}`, description: "", phase: "Jour 1", depends_on: [], assignee: null,
  estimated_hours: 2, rationale: "", skills: [], ...extra,
});
const task = (id: string, extra: Partial<StoredTask> = {}): StoredTask => ({
  id, title: `Task ${id}`, description: "", phase: "Jour 1", depends_on: [], assignee: null,
  estimated_hours: 2, rationale: "", skills: [], status: "todo", ...extra,
});
const team: TeamMember[] = [{ github: "alice", name: "Alice", role: "Dev", skills: [], capacity_hours_per_day: 2 }];
const repo = { owner: "acme", repo: "demo" };

describe("commandes", () => {
  it("reconnaît /valider, /apply et /replan avec sa consigne", () => {
    expect(parseCommand("/valider")).toEqual({ kind: "apply" });
    expect(parseCommand("  /APPLY merci")).toEqual({ kind: "apply" });
    expect(parseCommand("/replan on a pris\nune journée de retard")).toEqual({ kind: "replan", instruction: "on a pris\nune journée de retard" });
    expect(parseCommand("/replanifier")).toEqual({ kind: "replan", instruction: "" });
    expect(parseCommand("merci pour le /valider")).toBeNull();
    expect(parseCommand("/validerX")).toBeNull();
  });
});

describe("Epic", () => {
  it("lit les champs du formulaire et la durée en jours", () => {
    const epic = parseEpicBody("### Objectifs\n\nUne appli\n\n### Durée\n\n3 jours, du vendredi au dimanche\n\n### Contraintes\n\n_No response_");
    expect(epic).toMatchObject({ objectives: "Une appli", duration: "3 jours, du vendredi au dimanche", constraints: "" });
    expect(durationInDays(epic.duration)).toBe(3);
    expect(durationInDays("2,5 days")).toBe(3);
    expect(durationInDays("un week-end")).toBeNull();
  });
});

describe("plan", () => {
  it("retire un assigné inventé et normalise la casse", () => {
    const plan = finalizePlan({ summary: "", warnings: [], tasks: [llmTask("T1", { assignee: "ALICE" }), llmTask("T2", { assignee: "ghost" })] }, team, "fr");
    expect(plan.tasks.map((t) => t.assignee)).toEqual(["alice", null]);
    expect(plan.warnings).toHaveLength(1);
  });

  it("replanification : garde les ids des tâches conservées et les tâches terminées telles quelles", () => {
    const current = [task("a", { status: "done", title: "Fait" }), task("b"), task("c")];
    const plan = finalizeReplan(
      { summary: "", warnings: [], tasks: [llmTask("T2", { title: "B modifiée", depends_on: ["T1"] }), llmTask("N1")] },
      current, team, "fr",
    );
    expect(plan.tasks.map((t) => [t.id, t.title, t.status])).toEqual([
      ["b", "B modifiée", "todo"],
      [expect.any(String), "Task N1", "todo"],
      ["a", "Fait", "done"],
    ]);
    expect(plan.tasks[0]!.depends_on).toEqual(["a"]);
  });
});

describe("commentaire", () => {
  const state: PlanState = {
    applied: false,
    plan: { summary: "Résumé", warnings: [], duration_days: 3, tasks: [task("a", { assignee: "alice", estimated_hours: 7 }), task("b", { depends_on: ["a"] })] },
    issues: [],
  };

  it("relit l'état caché et affiche la charge par rapport à la capacité sur la durée", () => {
    const body = renderPlan(state, team, "fr");
    expect(decodeState(body)).toEqual(state);
    expect(body).toContain("| T2 | Task b | — | 2 h | T1 |");
    expect(body).toContain("| Alice | 7 h ⚠️ | 6 h |");
  });

  it("neutralise les mentions, le HTML et les « | » venus de l'IA", () => {
    const fake = `<!-- taskvibe:data ${Buffer.from("{}").toString("base64")} -->`;
    const body = renderPlan({ ...state, plan: { ...state.plan, tasks: [task("a", { title: `@bob a|b ${fake}` })] } }, null, "fr");
    expect(body).not.toContain("@bob");
    expect(body).toContain("a\\|b");
    expect(decodeState(body)?.plan.tasks[0]!.id).toBe("a");
  });
});

/** Faux Octokit : un dépôt en mémoire, et le journal des appels. */
function fakeGitHub({ failOnCreate }: { failOnCreate?: number } = {}) {
  const calls: string[] = [];
  const issues = new Map<number, { id: number; number: number; title: string; body: string; state: string; state_reason: string | null; assignees: { login: string }[]; labels: string[] }>();
  let next = 10;
  const octokit = {
    paginate: async (fn: (p: unknown) => Promise<{ data: unknown[] }>, params: unknown) => (await fn(params)).data,
    rest: {
      issues: {
        create: async ({ title, body, assignees = [] }: { title: string; body: string; assignees?: string[] }) => {
          if (issues.size === failOnCreate) throw Object.assign(new Error("boom"), { status: 500 });
          const number = next++;
          const issue = { id: number * 100, number, title, body, state: "open", state_reason: null, assignees: assignees.map((login) => ({ login })), labels: [] };
          issues.set(number, issue);
          calls.push(`create ${title}`);
          return { data: issue };
        },
        get: async ({ issue_number }: { issue_number: number }) => ({ data: issues.get(issue_number)! }),
        update: async ({ issue_number, ...patch }: { issue_number: number; state?: string; title?: string }) => {
          Object.assign(issues.get(issue_number)!, patch);
          calls.push(`update #${issue_number} ${JSON.stringify(patch).replace(/"owner":"acme","repo":"demo",?/, "")}`);
          return { data: {} };
        },
        addSubIssue: async ({ sub_issue_id }: { sub_issue_id: number }) => void calls.push(`sub ${sub_issue_id}`),
        removeSubIssue: async ({ sub_issue_id }: { sub_issue_id: number }) => void calls.push(`unsub ${sub_issue_id}`),
        listSubIssues: async () => ({ data: [...issues.values()] }),
        addBlockedByDependency: async ({ issue_number, issue_id }: { issue_number: number; issue_id: number }) =>
          void calls.push(`block #${issue_number} by ${issue_id}`),
        removeDependencyBlockedBy: async ({ issue_number, issue_id }: { issue_number: number; issue_id: number }) =>
          void calls.push(`unblock #${issue_number} by ${issue_id}`),
      },
    },
  };
  return { octokit: octokit as unknown as Octokit, calls, issues };
}

describe("application sur GitHub", () => {
  it("crée les prérequis d'abord, en sub-issues, avec les relations « bloquée par »", async () => {
    const { octokit, calls } = fakeGitHub();
    const state: PlanState = { applied: false, plan: { summary: "", warnings: [], tasks: [task("b", { depends_on: ["a"] }), task("a")] }, issues: [] };
    await applyPlan(octokit, repo, 1, state, "fr");
    expect(calls).toEqual(["create Task a", "sub 1000", "create Task b", "sub 1100", "block #11 by 1000"]);
    expect(state.issues.map((c) => [c.taskId, c.number])).toEqual([["a", 10], ["b", 11]]);
  });

  it("garde les issues déjà créées si une création échoue, et reprend sans doublon", async () => {
    const { octokit } = fakeGitHub({ failOnCreate: 1 });
    const state: PlanState = { applied: false, plan: { summary: "", warnings: [], tasks: [task("a"), task("b")] }, issues: [] };
    await expect(applyPlan(octokit, repo, 1, state, "fr")).rejects.toThrow("boom");
    expect(state.issues.map((c) => c.taskId)).toEqual(["a"]);
  });

  it("après /replan : ferme les tâches retirées, met à jour les modifiées, crée les nouvelles", async () => {
    const { octokit, calls, issues } = fakeGitHub();
    const state: PlanState = { applied: false, plan: { summary: "", warnings: [], tasks: [task("a"), task("b")] }, issues: [] };
    await applyPlan(octokit, repo, 1, state, "fr");
    calls.length = 0;

    const replanned: PlanState = { ...state, plan: { ...state.plan, tasks: [task("a", { title: "A renommée" }), task("n")] } };
    await applyPlan(octokit, repo, 1, replanned, "fr");
    expect(calls).toEqual([
      "unsub 1100",
      'update #11 {"state":"closed","state_reason":"not_planned"}',
      'update #10 {"title":"A renommée"}',
      "create Task n",
      "sub 1200",
    ]);
    expect(issues.get(11)!.state).toBe("closed");
  });

  it("relit l'état des issues avant /replan : fermée = terminée, non prévue = retirée", async () => {
    const { octokit, issues } = fakeGitHub();
    const state: PlanState = { applied: true, plan: { summary: "", warnings: [], tasks: [task("a"), task("b"), task("c", { depends_on: ["b"] })] }, issues: [] };
    await applyPlan(octokit, repo, 1, state, "fr");
    Object.assign(issues.get(10)!, { state: "closed", state_reason: "completed", title: "A sur GitHub" });
    Object.assign(issues.get(11)!, { state: "closed", state_reason: "not_planned" });

    const refreshed = await refreshFromGitHub(octokit, repo, 1, state);
    expect(refreshed.plan.tasks.map((t) => [t.id, t.title, t.status, t.depends_on])).toEqual([
      ["a", "A sur GitHub", "done", []],
      ["c", "Task c", "todo", []],
    ]);
    expect(refreshed.issues.map((c) => c.taskId)).toEqual(["a", "c"]);
  });
});
