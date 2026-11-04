// Point d'entrée de l'Action : un label `vibe-plan` génère un plan, `/valider` le crée sur GitHub,
// `/replan <consigne>` l'adapte. Lancée à la main (workflow_dispatch), elle prépare le dépôt.

import * as core from "@actions/core";
import { context, getOctokit } from "@actions/github";
import { messages, renderPlan, type PlanState } from "./comment.js";
import { durationInDays, parseEpicBody } from "./epic.js";
import { DEFAULT_FALLBACK_MODELS, geminiPlanner, isUnavailable } from "./gemini.js";
import { applyPlan, findLatestPlan, loadTeamSkills, refreshFromGitHub, statusOf, type Octokit, type Repo } from "./github.js";
import { finalizePlan, finalizeReplan } from "./plan.js";
import { buildReplanPrompt, buildUserPrompt, REPLAN_SYSTEM_PROMPT, SYSTEM_PROMPT } from "./prompts.js";
import type { Locale } from "./schema.js";

// Seules les personnes du dépôt peuvent lancer l'IA : sinon n'importe qui consommerait la clé du propriétaire
const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"];

type Command = { kind: "generate" } | { kind: "apply" } | { kind: "replan"; instruction: string };

/** Commande en tête d'un commentaire ; null si ce n'en est pas une. */
export function parseCommand(body: string): Command | null {
  const text = body.trim();
  if (/^\/(valider|apply)\b/i.test(text)) return { kind: "apply" };
  const replan = /^\/(replan|replanifier)\b([\s\S]*)$/i.exec(text);
  return replan ? { kind: "replan", instruction: replan[2]!.trim() } : null;
}

async function run(): Promise<void> {
  const octokit = getOctokit(core.getInput("github-token", { required: true }));
  const label = core.getInput("label") || "vibe-plan";
  const repo = context.repo;
  const { payload, eventName } = context;

  if (eventName === "workflow_dispatch") return setup(octokit, repo, label);

  const issue = payload.issue;
  if (!issue || issue.pull_request) return;

  let command: Command | null = null;
  let commentId: number | undefined;
  if (eventName === "issues" && payload.action === "labeled" && payload.label?.name === label) {
    // Mettre un label sur l'issue de quelqu'un d'autre demande déjà des droits ; un formulaire d'issue,
    // lui, pose le label pour n'importe quel auteur : on vérifie alors l'auteur.
    if (payload.sender?.login === issue.user.login && !TRUSTED.includes(issue.author_association)) {
      return core.info(`Ignoré : ${issue.user.login} n'est pas collaborateur du dépôt.`);
    }
    command = { kind: "generate" };
  } else if (eventName === "issue_comment" && payload.action === "created") {
    command = parseCommand(payload.comment?.body ?? "");
    if (command && !TRUSTED.includes(payload.comment!.author_association)) {
      return core.info(`Ignoré : ${payload.comment!.user.login} n'est pas collaborateur du dépôt.`);
    }
    commentId = payload.comment?.id;
  }
  if (!command) return;

  const issueNumber: number = issue.number;
  const say = (body: string) => octokit.rest.issues.createComment({ ...repo, issue_number: issueNumber, body });
  const edit = (id: number, body: string) => octokit.rest.issues.updateComment({ ...repo, comment_id: id, body });
  const react = (content: "eyes" | "rocket" | "confused") =>
    commentId ? octokit.rest.reactions.createForIssueComment({ ...repo, comment_id: commentId, content }) : undefined;

  let locale = (core.getInput("language") === "fr" ? "fr" : "en") as Locale;
  let progressId: number | undefined;
  try {
    await react("eyes");
    const teamSkills = await loadTeamSkills(octokit, repo);
    const team = teamSkills?.members ?? null;
    locale = teamSkills?.locale ?? locale;
    const m = messages(locale);
    const botLogin = core.getInput("bot-login") || "github-actions[bot]";
    const latest = await findLatestPlan(octokit, repo, issueNumber, botLogin);

    const generate = () => {
      const apiKey = core.getInput("gemini-api-key");
      if (!apiKey) throw new Error("GEMINI_API_KEY manquant : ajoute ta clé dans Settings → Secrets and variables → Actions.");
      const models = [...new Set([core.getInput("gemini-model") || "gemini-3.8-flash", ...DEFAULT_FALLBACK_MODELS])];
      return geminiPlanner(apiKey, models, core.warning);
    };

    if (command.kind === "generate") {
      if (latest?.state.issues.length) return void (await say(m.planExists));
      progressId = (await say(m.generating)).data.id;
      const epic = parseEpicBody(issue.body);
      const llmPlan = await generate()(SYSTEM_PROMPT, buildUserPrompt(issue.title, epic, team));
      const plan = { ...finalizePlan(llmPlan, team, locale), duration_days: durationInDays(epic.duration) };
      await edit(progressId, renderPlan({ applied: false, plan, issues: [] }, team, locale));
    } else if (command.kind === "apply") {
      if (!latest) return void (await say(m.noPlan));
      if (latest.state.applied) return void (await say(m.alreadyApplied));
      const state: PlanState = structuredClone(latest.state);
      try {
        await applyPlan(octokit, repo, issueNumber, state, locale);
        state.applied = true;
      } finally {
        // Même en cas d'échec : les issues déjà créées sont mémorisées, une relance ne les recrée pas
        await edit(latest.commentId, renderPlan(state, team, locale));
      }
      await react("rocket");
    } else {
      if (!latest) return void (await say(m.noPlan));
      if (!command.instruction) return void (await say(m.replanEmpty));
      progressId = (await say(m.replanning)).data.id;
      const base = await refreshFromGitHub(octokit, repo, issueNumber, latest.state);
      const prompt = buildReplanPrompt(issue.title, issue.body ?? "", team, base.plan.tasks, command.instruction);
      const llmPlan = await generate()(REPLAN_SYSTEM_PROMPT, prompt);
      const plan = { ...finalizeReplan(llmPlan, base.plan.tasks, team, locale), duration_days: base.plan.duration_days };
      await edit(progressId, renderPlan({ applied: false, plan, issues: base.issues }, team, locale));
    }
  } catch (err) {
    const reason = isUnavailable(err) ? messages(locale).providerUnavailable : err instanceof Error ? err.message : String(err);
    const body = messages(locale).failed(reason);
    await (progressId ? edit(progressId, body) : say(body)).catch(() => undefined);
    await react("confused")?.catch(() => undefined);
    throw err;
  }
}

/** Crée le label `vibe-plan` s'il n'existe pas encore. */
async function setup(octokit: Octokit, repo: Repo, label: string): Promise<void> {
  try {
    await octokit.rest.issues.getLabel({ ...repo, name: label });
    core.info(`Le label « ${label} » existe déjà.`);
  } catch (err) {
    if (statusOf(err) !== 404) throw err;
    await octokit.rest.issues.createLabel({ ...repo, name: label, color: "7c3aed", description: "Planifier cette Epic avec TaskVibe" });
    core.info(`Label « ${label} » créé.`);
  }
  core.info("Prêt : ajoute le label sur une issue qui décrit ton projet pour obtenir un plan.");
}

// Pas d'exécution pendant les tests, qui importent parseCommand
if (process.env.GITHUB_ACTIONS === "true") {
  run().catch((err: unknown) => core.setFailed(err instanceof Error ? err.message : String(err)));
}
