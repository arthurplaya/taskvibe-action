// Contrôle de la sortie du LLM : le schéma JSON garantit la forme, pas la cohérence
// (logins inventés, durées absurdes, dépendances cassées). Conversion en plan avec identifiants stables.

import { randomUUID } from "node:crypto";
import { taskRef } from "./prompts.js";
import { sanitizeDependencies, type LlmPlan, type LlmTask, type Locale, type StoredPlan, type StoredTask, type TeamMember } from "./schema.js";

/** Sortie inutilisable : relancer la commande. */
export class InvalidPlanError extends Error {}

const MAX_TASKS = 80;
const MAX_TASK_HOURS = 200;

const notes = {
  en: {
    unknownAssignee: (login: string, title: string) => `"${login}" is not in .team-skills.yml: task "${title}" was left unassigned.`,
    droppedDependencies: (n: number) => `${n} invalid dependency link(s) were removed (unknown task or cycle).`,
  },
  fr: {
    unknownAssignee: (login: string, title: string) => `« ${login} » n'est pas dans .team-skills.yml : la tâche « ${title} » est restée sans assigné.`,
    droppedDependencies: (n: number) => `${n} lien(s) de dépendance invalide(s) retiré(s) (tâche inconnue ou cycle).`,
  },
};

/** `existing` : tâches déjà dans le plan, par ref ; une tâche qui reprend leur ref garde leur identifiant et leur statut. */
export function toStoredPlan(plan: LlmPlan, existing = new Map<string, StoredTask>()): StoredPlan {
  // En cas de ref en double, la première tâche qui la porte fait foi
  const idByRef = new Map<string, string>();
  const ids = plan.tasks.map((task) => {
    if (idByRef.has(task.ref)) return randomUUID();
    const id = existing.get(task.ref)?.id ?? randomUUID();
    idByRef.set(task.ref, id);
    return id;
  });
  const statusOf = (ref: string, id: string) => (existing.get(ref)?.id === id ? existing.get(ref)!.status : "todo");

  const tasks: StoredTask[] = plan.tasks.map(({ ref: _ref, depends_on, ...task }, i) => ({
    ...task,
    id: ids[i]!,
    depends_on: depends_on.map((ref) => idByRef.get(ref)).filter((id): id is string => Boolean(id)),
    status: statusOf(plan.tasks[i]!.ref, ids[i]!),
  }));
  return { ...plan, tasks: sanitizeDependencies(tasks).tasks };
}

export function finalizePlan(llmPlan: LlmPlan, team: TeamMember[] | null, locale: Locale, existing?: Map<string, StoredTask>): StoredPlan {
  if (llmPlan.tasks.length === 0) throw new InvalidPlanError("Le plan généré ne contient aucune tâche");
  if (llmPlan.tasks.length > MAX_TASKS) throw new InvalidPlanError(`Plan trop long (${llmPlan.tasks.length} tâches)`);

  const warnings = [...llmPlan.warnings];
  const tasks = llmPlan.tasks.map((task) => checkTask(task, team, locale, warnings));
  const stored = toStoredPlan({ ...llmPlan, tasks }, existing);

  const declaredLinks = llmPlan.tasks.reduce((sum, t) => sum + t.depends_on.length, 0);
  const keptLinks = stored.tasks.reduce((sum, t) => sum + t.depends_on.length, 0);
  if (keptLinks < declaredLinks) warnings.push(notes[locale].droppedDependencies(declaredLinks - keptLinks));
  return { ...stored, warnings };
}

/**
 * Plan proposé par /replan : les tâches conservées gardent leur identifiant (donc leur issue GitHub),
 * et les tâches terminées restent telles quelles, même si l'IA les a modifiées ou oubliées.
 */
export function finalizeReplan(llmPlan: LlmPlan, current: StoredTask[], team: TeamMember[] | null, locale: Locale): StoredPlan {
  const existing = new Map(current.map((t, i) => [taskRef(i), t]));
  // Tâches terminées oubliées par l'IA : remises dans sa réponse, pour rester référençables comme dépendances
  const returned = new Set(llmPlan.tasks.map((t) => t.ref));
  const forgotten = [...existing]
    .filter(([ref, t]) => t.status === "done" && !returned.has(ref))
    .map(([ref, { id: _id, status: _status, ...t }]) => ({ ...t, ref, depends_on: [] }));
  const plan = finalizePlan({ ...llmPlan, tasks: [...llmPlan.tasks, ...forgotten] }, team, locale, existing);
  const done = new Map(current.filter((t) => t.status === "done").map((t) => [t.id, t]));
  const tasks = plan.tasks.map((t) => done.get(t.id) ?? t);
  // Phases dans leur ordre d'origine (chronologique), les nouvelles à la suite
  const phases = [...new Set([...current, ...tasks].map((t) => t.phase))];
  tasks.sort((a, b) => phases.indexOf(a.phase) - phases.indexOf(b.phase));
  return { ...plan, tasks: sanitizeDependencies(tasks).tasks };
}

function checkTask(task: LlmTask, team: TeamMember[] | null, locale: Locale, warnings: string[]): LlmTask {
  if (!task.title.trim()) throw new InvalidPlanError("Tâche sans titre");
  if (!(task.estimated_hours > 0) || task.estimated_hours > MAX_TASK_HOURS) {
    throw new InvalidPlanError(`Durée invalide (${task.estimated_hours} h) pour « ${task.title} »`);
  }
  const member = team?.find((m) => m.github.toLowerCase() === task.assignee?.toLowerCase());
  if (task.assignee && !member) {
    warnings.push(notes[locale].unknownAssignee(task.assignee, task.title));
    return { ...task, assignee: null };
  }
  // Normalise la casse du login sur celle déclarée dans l'équipe
  return { ...task, assignee: member?.github ?? task.assignee };
}
