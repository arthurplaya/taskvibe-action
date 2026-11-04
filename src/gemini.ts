// Appel à Gemini avec la clé de l'utilisateur (offre gratuite sur https://aistudio.google.com).
// ⚠️ Offre gratuite : Google indique que le contenu envoyé sert à améliorer ses produits.

import { GoogleGenAI } from "@google/genai";
import { z } from "zod";
import { LlmPlanSchema, type LlmPlan } from "./schema.js";

/** Modèles essayés quand le modèle principal est surchargé (les « flash » récents saturent souvent). */
export const DEFAULT_FALLBACK_MODELS = ["gemini-3.6-flash", "gemini-3-flash-preview", "gemini-3.5-flash"];

export type GeneratePlan = (system: string, prompt: string) => Promise<LlmPlan>;

export function geminiPlanner(apiKey: string, models: string[], warn: (message: string) => void): GeneratePlan {
  const client = new GoogleGenAI({ apiKey });
  const { $schema: _, ...jsonSchema } = z.toJSONSchema(LlmPlanSchema);

  return async (system, prompt) => {
    let lastError: unknown;
    for (const [index, model] of models.entries()) {
      try {
        const response = await client.models.generateContent({
          model,
          contents: prompt,
          config: {
            systemInstruction: system,
            responseMimeType: "application/json",
            responseJsonSchema: jsonSchema,
            // Une tentative par modèle : insister sur un modèle saturé fait perdre du temps
            httpOptions: { timeout: 180_000, retryOptions: { attempts: 1 } },
          },
        });
        const text = response.text;
        if (!text) {
          const reason = response.candidates?.[0]?.finishReason ?? response.promptFeedback?.blockReason ?? "inconnue";
          throw new Error(`Réponse Gemini vide (raison : ${reason})`);
        }
        // Gemini respecte le schéma, mais on revalide : c'est ce JSON qui créera des issues.
        const parsed = LlmPlanSchema.safeParse(JSON.parse(text));
        if (!parsed.success) throw new Error(`Réponse Gemini non conforme au schéma :\n${z.prettifyError(parsed.error)}`);
        return parsed.data;
      } catch (err) {
        if (!isUnavailable(err)) throw err;
        lastError = err;
        const next = models[index + 1];
        if (next) warn(`Gemini ${model} indisponible (${describe(err)}), bascule sur ${next}`);
      }
    }
    throw lastError;
  };
}

/** Surcharge, délai dépassé ou modèle retiré (404) : on tente le modèle suivant. */
export function isUnavailable(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const status = "status" in err ? err.status : undefined;
  if (typeof status === "number") return status === 404 || status === 408 || status === 429 || status >= 500;
  const name = "name" in err ? err.name : undefined;
  return name === "AbortError" || name === "TimeoutError";
}

function describe(err: unknown): string {
  if (typeof err === "object" && err !== null && "status" in err) return `HTTP ${String(err.status)}`;
  return err instanceof Error ? err.name : "erreur";
}
