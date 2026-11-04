// Schémas du plan : ce que le LLM produit, puis ce qui est mémorisé dans le commentaire du bot.

import { z } from "zod";

// --- Sortie du LLM ---
// Le LLM ne connaît pas les identifiants définitifs : il référence les tâches par un `ref` court
// ("T1", "T2"...), converti en identifiants stables à l'enregistrement.

export const LlmTaskSchema = z.object({
  ref: z.string().describe("Référence courte et unique de la tâche dans ce plan : T1, T2, T3..."),
  title: z.string().describe("Titre court et actionnable de la tâche"),
  description: z.string().describe("Description détaillée : contexte, étapes, critères de fin"),
  phase: z.string().describe("Phase ou jalon du projet auquel la tâche appartient (ex : Conception, Prototypage)"),
  depends_on: z
    .array(z.string())
    .describe("Refs des tâches qui doivent être terminées avant de commencer celle-ci (vide si aucune)"),
  assignee: z
    .string()
    .nullable()
    .describe("Login GitHub d'un membre de l'équipe, ou null si personne n'a les compétences"),
  estimated_hours: z.number().describe("Durée estimée en heures de travail effectif, strictement positive"),
  rationale: z.string().describe("Pourquoi cette personne : compétences, rôle, charge disponible"),
  skills: z.array(z.string()).describe("Compétences requises (ex : CAO, firmware C, achats)"),
});

export const LlmPlanSchema = z.object({
  summary: z.string().describe("Résumé du découpage en deux ou trois phrases"),
  tasks: z.array(LlmTaskSchema),
  warnings: z
    .array(z.string())
    .describe("Risques ou manques détectés : compétence absente, surcharge, info manquante"),
});

export type LlmTask = z.infer<typeof LlmTaskSchema>;
export type LlmPlan = z.infer<typeof LlmPlanSchema>;

// --- Plan stocké et édité ---

export const TaskStatusSchema = z.enum(["todo", "in_progress", "done"]);

export const StoredTaskSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  description: z.string(),
  phase: z.string(),
  /** Identifiants des tâches prérequises */
  depends_on: z.array(z.string()),
  assignee: z.string().nullable(),
  estimated_hours: z.number().positive(),
  rationale: z.string(),
  skills: z.array(z.string()),
  status: TaskStatusSchema,
});

export const StoredPlanSchema = z.object({
  summary: z.string(),
  tasks: z.array(StoredTaskSchema),
  warnings: z.array(z.string()),
  /** Nombre de jours tiré du champ « Durée » de l'Epic : capacité par jour × jours = capacité du projet */
  duration_days: z.number().int().positive().nullable().optional(),
});

export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type StoredTask = z.infer<typeof StoredTaskSchema>;
export type StoredPlan = z.infer<typeof StoredPlanSchema>;

// --- Équipe (.team-skills.yml) ---

export const TeamMemberSchema = z.object({
  github: z.string().min(1),
  name: z.string().optional(),
  role: z.string(),
  skills: z.array(z.string()).default([]),
  capacity_hours_per_week: z.number().positive().optional(),
  /** Pour les projets courts (hackathon) : disponibilité par jour */
  capacity_hours_per_day: z.number().positive().optional(),
});

export const TeamSkillsSchema = z.object({
  /** Langue des commentaires du bot pour ce dépôt */
  locale: z.enum(["en", "fr"]).optional(),
  members: z.array(TeamMemberSchema).min(1),
});

export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamSkills = z.infer<typeof TeamSkillsSchema>;

export type Locale = "en" | "fr";

// --- Dépendances ---

interface DependentTask {
  id: string;
  depends_on: string[];
}

/** Renvoie true si ajouter `dependsOn` comme prérequis de `taskId` créerait un cycle. */
export function wouldCreateCycle(tasks: DependentTask[], taskId: string, dependsOn: string): boolean {
  if (taskId === dependsOn) return true;
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const stack = [dependsOn];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (current === taskId) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    stack.push(...(byId.get(current)?.depends_on ?? []));
  }
  return false;
}

/** Retire les dépendances vers une tâche inexistante, vers soi-même, en double, ou qui fermeraient un cycle. */
export function sanitizeDependencies<T extends DependentTask>(tasks: T[]): { tasks: T[]; removed: number } {
  const ids = new Set(tasks.map((t) => t.id));
  const kept: T[] = tasks.map((t) => ({ ...t, depends_on: [] }));
  let removed = 0;
  for (const [index, task] of tasks.entries()) {
    for (const dep of new Set(task.depends_on)) {
      if (!ids.has(dep) || wouldCreateCycle(kept, task.id, dep)) {
        removed++;
        continue;
      }
      kept[index]!.depends_on.push(dep);
    }
    removed += task.depends_on.length - new Set(task.depends_on).size;
  }
  return { tasks: kept, removed };
}
