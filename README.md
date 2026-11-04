# TaskVibe

**Décris ton projet dans une issue GitHub : l'IA le découpe en tâches, les répartit dans l'équipe selon les compétences et les disponibilités de chacun, puis crée les sub-issues.** Si vous prenez du retard ou changez d'idée, une commande suffit pour replanifier.

Tout se passe dans GitHub, avec ta propre clé d'IA (Gemini, gratuite). Il n'y a ni serveur ni compte à créer.

## Installation (5 minutes, une fois par dépôt)

1. **La clé d'IA.** Crée une clé gratuite sur [Google AI Studio](https://aistudio.google.com/apikey), puis ajoute-la dans ton dépôt, dans *Settings → Secrets and variables → Actions → New repository secret*, sous le nom `GEMINI_API_KEY`.
2. **Le workflow.** Copie [`examples/.github/workflows/taskvibe.yml`](examples/.github/workflows/taskvibe.yml) dans `.github/workflows/taskvibe.yml` de ton dépôt.
3. **Le label.** Dans l'onglet *Actions*, choisis *TaskVibe*, puis *Run workflow*. Cette étape crée le label `vibe-plan`.
4. **L'équipe** (recommandé). Ajoute un fichier `.team-skills.yml` à la racine du dépôt, sur le modèle de [`examples/.team-skills.yml`](examples/.team-skills.yml). Il contient les logins GitHub, les rôles, les compétences et les disponibilités par jour ou par semaine. Sans ce fichier, les tâches ne sont pas assignées.
5. **Le formulaire** (facultatif). Copie [`examples/.github/ISSUE_TEMPLATE/projet.yml`](examples/.github/ISSUE_TEMPLATE/projet.yml) dans `.github/ISSUE_TEMPLATE/`. Le formulaire guide la description du projet (objectifs, livrables, durée, contraintes) et pose le label automatiquement.

## Utilisation

| Où | Quoi | Résultat |
|---|---|---|
| Une issue qui décrit le projet | Ajouter le label `vibe-plan` | Le plan proposé s'affiche en commentaire : tâches par phase, assignés, durées, dépendances, charge de chacun |
| Commentaire | `/valider` (ou `/apply`) | Les tâches deviennent des sub-issues de l'Epic, avec leurs assignés et leurs relations « bloquée par » |
| Commentaire | `/replan <consigne>` | Un nouveau plan est proposé. Ensuite, `/valider` l'applique : nouvelles issues créées, issues modifiées mises à jour, tâches retirées fermées |

Exemples de consignes :
- `/replan on a perdu une journée, recentre sur l'essentiel`
- `/replan ajoute un système de notifications`
- `/replan Inès n'est plus disponible demain`

Les tâches sont numérotées T1, T2… dans le commentaire. Tu peux donc y faire référence, par exemple `/replan supprime T4 et fusionne T6 et T7`.

**Avant chaque `/replan`, TaskVibe relit les issues.** Une issue fermée compte comme terminée et n'est pas modifiée. Une issue fermée comme « non prévue » est retirée du plan. Les titres, descriptions et assignés modifiés sur GitHub sont pris en compte.

Si l'Epic indique une durée en jours (par exemple « 3 jours »), les phases deviennent des créneaux chronologiques, comme « Jour 1 – matin ». La charge de chacun est alors comparée à sa disponibilité par jour multipliée par le nombre de jours.

## Bon à savoir

- **Coût** : c'est gratuit. Les dépôts publics ont des minutes d'Actions illimitées, et un compte gratuit en a 2 000 par mois pour les dépôts privés. Une commande prend une à trois minutes.
- **Qui peut lancer l'IA** : seuls le propriétaire, les membres et les collaborateurs du dépôt. Les commandes des autres sont ignorées, pour que personne ne consomme ta clé.
- **Confidentialité** : sur l'offre gratuite, Google indique que le contenu envoyé à Gemini peut servir à améliorer ses produits. N'y mets rien de confidentiel.
- **Où est le plan ?** Dans le commentaire du bot, sous forme de données cachées. Il n'y a aucune base de données, tout reste dans ton dépôt.
- **Modèle** : `gemini-3.8-flash` par défaut, avec bascule automatique sur d'autres modèles Gemini s'il est surchargé. Pour en changer : `with: gemini-model: <modèle>`.

## Options

| Entrée | Par défaut | Rôle |
|---|---|---|
| `gemini-api-key` | | Clé Gemini, à passer depuis un secret |
| `label` | `vibe-plan` | Label qui déclenche la génération |
| `language` | `en` | Langue des messages si `.team-skills.yml` ne précise pas `locale` |
| `gemini-model` | `gemini-3.8-flash` | Modèle principal |

## Développement

```sh
npm install
npm test            # tests
npm run typecheck
npm run build       # compile dans dist/index.mjs, à commiter
```

Licence MIT.
