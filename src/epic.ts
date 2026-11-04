// Parse le corps d'une Epic créée avec un formulaire d'issue (anglais ou français).
// GitHub rend chaque champ du formulaire sous la forme "### <Libellé>\n\n<valeur>".

export interface EpicContent {
  objectives: string;
  deliverables: string;
  constraints: string;
  /** Durée du projet (ex : « 3 jours, du vendredi 9 h au dimanche 16 h ») */
  duration: string;
  /** Corps brut, transmis au LLM si l'Epic ne suit pas le formulaire. */
  raw: string;
}

const SECTION_KEYS: Record<string, keyof Omit<EpicContent, "raw">> = {
  objectives: "objectives",
  objectifs: "objectives",
  deliverables: "deliverables",
  livrables: "deliverables",
  constraints: "constraints",
  contraintes: "constraints",
  duration: "duration",
  duree: "duration",
};

// Valeur insérée par GitHub quand un champ optionnel du formulaire est vide
const EMPTY_FIELD = "_No response_";

export function parseEpicBody(body: string | null | undefined): EpicContent {
  const raw = body ?? "";
  const epic: EpicContent = { objectives: "", deliverables: "", constraints: "", duration: "", raw };
  for (const section of raw.split(/^###\s+/m).slice(1)) {
    const newline = section.indexOf("\n");
    const heading = (newline === -1 ? section : section.slice(0, newline)).trim();
    const value = newline === -1 ? "" : section.slice(newline + 1).trim();
    const key = SECTION_KEYS[normalize(heading)];
    if (key && value !== EMPTY_FIELD) epic[key] = value;
  }
  return epic;
}

/** « 3 jours », « 2,5 days » → nombre de jours (arrondi au supérieur) ; null si la durée n'est pas en jours. */
export function durationInDays(duration: string): number | null {
  const match = /(\d+(?:[.,]\d+)?)\s*(?:jours?|days?|j|d)\b/i.exec(duration);
  const days = match ? Math.ceil(Number(match[1]!.replace(",", "."))) : 0;
  return days > 0 ? days : null;
}

function normalize(heading: string): string {
  return heading
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
