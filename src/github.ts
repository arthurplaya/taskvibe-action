// Lecture et écriture sur GitHub : équipe, commentaires du bot, issues du plan.

import type { getOctokit } from "@actions/github";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { decodeState, descriptionFromIssueBody, messages, PLAN_MARKER, taskIssueBody, type CreatedIssue, type PlanState } from "./comment.js";
import { TeamSkillsSchema, type Locale, type StoredTask, type TeamSkills } from "./schema.js";

export type Octokit = ReturnType<typeof getOctokit>;
export interface Repo {
  owner: string;
  repo: string;
}

export const TEAM_SKILLS_PATH = ".team-skills.yml";
// GitHub n'a pas de statut « en cours » natif : il est porté par un label
const IN_PROGRESS_LABEL = "in progress";

/** null si le fichier n'existe pas ; lève une erreur lisible s'il est invalide. */
export async function loadTeamSkills(octokit: Octokit, repo: Repo): Promise<TeamSkills | null> {
  let content: string;
  try {
    const { data } = await octokit.rest.repos.getContent({ ...repo, path: TEAM_SKILLS_PATH });
    if (Array.isArray(data) || data.type !== "file") return null;
    content = Buffer.from(data.content, "base64").toString("utf8");
  } catch (err) {
    if (statusOf(err) === 404) return null;
    throw err;
  }
  const result = TeamSkillsSchema.safeParse(parseYaml(content));
  if (!result.success) throw new Error(`${TEAM_SKILLS_PATH} invalide :\n${z.prettifyError(result.error)}`);
  return result.data;
}

/** Dernier commentaire de plan publié par le bot sur l'issue. */
export async function findLatestPlan(octokit: Octokit, repo: Repo, issueNumber: number, botLogin: string) {
  const comments = await octokit.paginate(octokit.rest.issues.listComments, { ...repo, issue_number: issueNumber, per_page: 100 });
  // Seuls les commentaires du bot font foi : n'importe qui peut écrire un commentaire qui imite le format
  const mine = comments.filter((c) => c.user?.login === botLogin && c.body?.startsWith(PLAN_MARKER));
  for (const comment of mine.reverse()) {
    const state = decodeState(comment.body!);
    if (state) return { commentId: comment.id, state };
  }
  return null;
}

/**
 * Tâches du plan appliqué, mises à jour avec l'état réel des issues (titre, description, assigné, statut).
 * Une issue supprimée, ou fermée « non prévue », retire sa tâche du plan.
 */
export async function refreshFromGitHub(octokit: Octokit, repo: Repo, epicNumber: number, state: PlanState): Promise<PlanState> {
  if (!state.issues.length) return state;
  const subIssues = await octokit.paginate(octokit.rest.issues.listSubIssues, { ...repo, issue_number: epicNumber, per_page: 100 });
  const byId = new Map(subIssues.map((issue) => [issue.id, issue]));
  const issueOf = new Map(state.issues.map((c) => [c.taskId, c]));

  const tasks: StoredTask[] = [];
  for (const task of state.plan.tasks) {
    const entry = issueOf.get(task.id);
    if (!entry) {
      tasks.push(task);
      continue;
    }
    const issue = byId.get(entry.id);
    if (!issue || issue.state_reason === "not_planned") continue;
    const labels = (issue.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? "")).toLowerCase());
    const assignees = (issue.assignees ?? []).map((a) => a.login);
    tasks.push({
      ...task,
      title: issue.title,
      description: descriptionFromIssueBody(issue.body),
      assignee: !assignees.length || assignees.some((a) => sameLogin(a, task.assignee)) ? task.assignee : assignees[0]!,
      status: issue.state === "closed" ? "done" : labels.includes(IN_PROGRESS_LABEL) ? "in_progress" : "todo",
    });
  }
  const kept = new Set(tasks.map((t) => t.id));
  const dropped = new Set(state.plan.tasks.filter((t) => !kept.has(t.id)).map((t) => t.id));
  return {
    ...state,
    plan: { ...state.plan, tasks: tasks.map((t) => ({ ...t, depends_on: t.depends_on.filter((d) => !dropped.has(d)) })) },
    issues: state.issues.filter((c) => kept.has(c.taskId)),
  };
}

/**
 * Applique le plan sur GitHub : ferme les issues des tâches retirées, crée celles des nouvelles tâches
 * (rattachées à l'Epic comme sub-issues), aligne les autres, puis les relations « bloquée par ».
 *
 * `issues` est modifié au fur et à mesure : en cas d'erreur, l'appelant enregistre ce qui a déjà été fait,
 * et une relance reprend sans recréer d'issue.
 */
export async function applyPlan(octokit: Octokit, repo: Repo, epicNumber: number, state: PlanState, locale: Locale): Promise<void> {
  const { plan, issues } = state;
  const taskIds = new Set(plan.tasks.map((t) => t.id));

  for (const entry of issues.filter((c) => !taskIds.has(c.taskId))) {
    await ignoreStatus([404, 422], () => octokit.rest.issues.removeSubIssue({ ...repo, issue_number: epicNumber, sub_issue_id: entry.id }));
    await ignoreStatus([404, 410], () =>
      octokit.rest.issues.update({ ...repo, issue_number: entry.number, state: "closed", state_reason: "not_planned" }),
    );
    issues.splice(issues.indexOf(entry), 1);
  }

  const byTask = new Map(issues.map((c) => [c.taskId, c]));
  // Les prérequis d'abord : leur numéro peut alors figurer dans le corps de l'issue
  for (const task of topologicalOrder(plan.tasks)) {
    const blockers = task.depends_on.map((id) => byTask.get(id)).filter((c): c is CreatedIssue => c !== undefined);
    const body = taskIssueBody(task, epicNumber, blockers.map((b) => b.number), locale);
    let entry = byTask.get(task.id);

    if (!entry) {
      const issue = await createIssue(octokit, repo, task, body, locale);
      entry = { taskId: task.id, id: issue.id, number: issue.number, blockedByIds: [] };
      issues.push(entry);
      byTask.set(task.id, entry);
      // L'API attend l'identifiant interne de l'issue, pas son numéro
      await octokit.rest.issues.addSubIssue({ ...repo, issue_number: epicNumber, sub_issue_id: issue.id });
    } else if (task.status !== "done") {
      await alignIssue(octokit, repo, entry.number, task, body);
    }

    const wanted = blockers.map((b) => b.id);
    for (const id of wanted.filter((id) => !entry.blockedByIds.includes(id))) {
      // 422 : relation déjà présente (reprise après interruption)
      await ignoreStatus([422], () => octokit.rest.issues.addBlockedByDependency({ ...repo, issue_number: entry.number, issue_id: id }));
    }
    for (const id of entry.blockedByIds.filter((id) => !wanted.includes(id))) {
      await ignoreStatus([404], () => octokit.rest.issues.removeDependencyBlockedBy({ ...repo, issue_number: entry.number, issue_id: id }));
    }
    entry.blockedByIds = wanted;
  }
}

async function createIssue(octokit: Octokit, repo: Repo, task: StoredTask, body: string, locale: Locale) {
  const params = { ...repo, title: task.title, body };
  if (!task.assignee) return (await octokit.rest.issues.create(params)).data;
  try {
    return (await octokit.rest.issues.create({ ...params, assignees: [task.assignee] })).data;
  } catch (err) {
    // 422 : la personne n'a pas accès au dépôt. On crée l'issue sans assigné plutôt que d'échouer.
    if (statusOf(err) !== 422) throw err;
    return (await octokit.rest.issues.create({ ...params, body: `${body}\n\n${messages(locale).assignFailed(task.assignee)}` })).data;
  }
}

/** Titre, corps et assigné de l'issue d'une tâche modifiée par /replan. */
async function alignIssue(octokit: Octokit, repo: Repo, issueNumber: number, task: StoredTask, body: string): Promise<void> {
  const { data: issue } = await octokit.rest.issues.get({ ...repo, issue_number: issueNumber });
  const patch: { title?: string; body?: string } = {};
  if (issue.title !== task.title) patch.title = task.title;
  if (normalize(issue.body) !== normalize(body)) patch.body = body;
  // Un assigné supplémentaire ajouté sur GitHub est conservé tant que celui du plan en fait partie
  const assignees = (issue.assignees ?? []).map((a) => a.login);
  const reassign = task.assignee !== null && !assignees.some((a) => sameLogin(a, task.assignee));

  if (Object.keys(patch).length) await octokit.rest.issues.update({ ...repo, issue_number: issueNumber, ...patch });
  if (reassign) {
    // 422 : la personne n'a pas accès au dépôt ; la tâche garde son assigné actuel
    await ignoreStatus([422], () => octokit.rest.issues.update({ ...repo, issue_number: issueNumber, assignees: [task.assignee!] }));
  }
}

/** Ordre de création : chaque tâche après ses prérequis, en gardant l'ordre du plan sinon. */
export function topologicalOrder(tasks: StoredTask[]): StoredTask[] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const ordered: StoredTask[] = [];
  const visited = new Set<string>();
  const visit = (task: StoredTask, path: Set<string>) => {
    if (visited.has(task.id) || path.has(task.id)) return;
    path.add(task.id);
    for (const dep of task.depends_on) {
      const prerequisite = byId.get(dep);
      if (prerequisite) visit(prerequisite, path);
    }
    visited.add(task.id);
    ordered.push(task);
  };
  for (const task of tasks) visit(task, new Set());
  return ordered;
}

async function ignoreStatus(statuses: number[], fn: () => Promise<unknown>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!statuses.includes(statusOf(err) ?? 0)) throw err;
  }
}

const normalize = (value: string | null | undefined) => (value ?? "").replace(/\r\n/g, "\n").trim();
const sameLogin = (a: string, b: string | null) => b !== null && a.toLowerCase() === b.toLowerCase();

export function statusOf(err: unknown): number | undefined {
  return typeof err === "object" && err !== null && "status" in err ? (err.status as number) : undefined;
}
