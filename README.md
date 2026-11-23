# Pré-fly

Pré-vol PDF pour l'atelier d'impression (Konica AccurioPrint C4065). Déposez un PDF, lisez un
rapport complet, allégez le fichier si nécessaire.

Application **macOS / Windows / Linux** (Electron) + **version web** identique, plus une landing
page de téléchargement. Tout est traité en local : aucun fichier n'est envoyé sur un serveur.

## Ce que fait l'outil

| Contrôle | Détails |
| --- | --- |
| **Typographies** | polices non embarquées, sous-ensembles incomplets, Type 3, absence de table ToUnicode, glyphes manquants (�), nombre de polices |
| **Images** | dpi réels à la taille d'impression, poids par image, bitmaps > 50 Mpx, JPEG 2000 / JBIG2, masques et transparence |
| **Volume** | fichier > 120 Mo (bloquant > 250 Mo), > 120 pages (alerte à 250), > 12 polices |
| **Couleurs & profils** | tons directs (Separation / DeviceN), RVB seul, ICC intégrés, OutputIntent, surimpression, calques OCG, transparence |
| **Contenu exotique** | SVG (fichier joint, flux XML, code), fichiers embarqués, JavaScript, actions Launch / GoToR, 3D, RichMedia, formulaires, XMP, données propriétaires |
| **Code dans le texte** | balises SVG / XML / HTML, JavaScript, CSS, Python, gabarits, PostScript, base64 — page par page |
| **Structure** | version PDF, chiffrement, mises à jour incrémentales, fin de fichier, formats de page hétérogènes, TrimBox / BleedBox |

Verdict en trois états : **Conforme** (ok), **À vérifier** (check), **Non conforme** (ko), avec un
score sur 100 et la liste des corrections.

### Allègement

Deux méthodes, sur n'importe quel fichier (pas seulement ceux en alerte) :

1. **Compression** — réécriture propre du PDF, retrait des métadonnées, vignettes, contenu actif et
   pièces jointes, réencodage des images JPEG au-delà de 300 dpi. Le vectoriel, les tons directs et
   les profils sont conservés.
2. **Rasterisation** — chaque page est rendue à 150, 200 ou 300 dpi (200 par défaut, PDF.js + canvas) puis
   recomposée en PDF. Tout ce que le RIP ne sait pas lire disparaît : SVG, code, transparence,
   polices exotiques. Le texte n'est plus vectoriel.

Sur ordinateur, le fichier de sortie est écrit **à côté du PDF d'origine** (`fichier-compresse.pdf`,
`fichier-raster-200dpi.pdf`), avec repli sur « Enregistrer sous ». Sur le web, il est téléchargé.

## Seuils (profil Konica AccurioPrint C4065)

Les valeurs vivent dans un seul fichier : [`src/core/thresholds.ts`](./src/core/thresholds.ts).
Elles sont jointes à chaque rapport (JSON et interface) pour rester traçables.

| Contrôle | Alerte | Bloquant |
| --- | --- | --- |
| Résolution d'image | < 200 dpi | < 120 dpi |
| Sur-échantillonnage | > 450 dpi | — |
| Poids d'une image | > 10 Mo | > 25 Mo |
| Bitmap | > 50 Mpx | — |
| Poids du fichier | > 120 Mo | > 250 Mo |
| Volume | > 120 pages | > 250 pages (alerte renforcée) |
| Nombre de polices | > 12 | — |
| Compression | conserve 300 dpi (± 15) | — |
| Rasterisation | 150 / 200 (défaut) / 300 dpi | — |

Cible d'impression : 300 dpi à taille finale. Justification : la C4065 est une presse toner
quadri avec un RIP Fiery ; au-delà de 450 dpi le gain visuel est nul alors que le décodage coûte
de la mémoire, et sous 200 dpi les travées apparaissent sur les aplats.

## Démarrage

```bash
npm install
npm run dev          # interface web sur http://localhost:5173
npm run dev:electron # application de bureau en mode développement
```

Prérequis : Node 20+ (CI : Node 22).

### Scripts

| Commande | Effet |
| --- | --- |
| `npm run dev` | serveur Vite (interface) |
| `npm run dev:electron` | build Electron + lancement de la fenêtre |
| `npm run build:web` | landing + version web dans `dist/` |
| `npm run build` | `dist/` + `electron/dist/` |
| `npm run dist:mac` / `dist:win` / `dist:linux` | installeurs dans `release/` |
| `npm test` | suite Vitest (analyseur, détection de code) |
| `npm run typecheck` | TypeScript strict, sans émission |
| `npm run icons` | régénère `build/icon.png`, `.ico`, `.icns` |

## Architecture

```
src/core/          moteur d'analyse (aucune dépendance DOM)
  rawscan.ts       reconnaissance octet par octet, tolérante aux fichiers cassés
  pdfdoc.ts        accès objets/page/streams via pdf-lib
  content.ts       interpréteur de flux de contenu (Tf, Do, cs/scn, gs, BDC…)
  code.ts          détection de code dans le texte
  analyze.ts       rapport, verdict, score
  optimize.ts      compression + rasterisation
src/lib/pdfjs.ts   extraction de texte et rendu de pages (PDF.js)
src/components/    interface (React)
electron/          processus principal + preload (IPC fichiers, protocole app://)
landing/           landing page statique
tests/             fixtures PDF construites à la main + assertions
```

Le moteur travaille directement sur les octets : pas de dépendance à un interpréteur PDF complet
pour la partie structurelle, ce qui permet d'analyser des fichiers dont la table xref est cassée.
Le texte est extrait par PDF.js (encodages, CMap, ToUnicode) pour la partie typographique.

## Intégration continue

- `.github/workflows/ci.yml` — types, tests, build web (artifact).
- `.github/workflows/build.yml` — installeurs macOS (arm64 + x64), Windows, Linux pour chaque tag
  `v*`, puis publication automatique dans la Release.
- `.github/workflows/pages.yml` — publie la landing et la version web sur GitHub Pages.

Le premier job « Build apps » télécharge Electron sur les runners GitHub (réseau complet). En local
dans un environnement réseau restreint, l'archive Electron peut être indisponible : `npm run dist`
échouera, alors que `npm run build:web` et `npm test` passent.

## Publier sur GitHub

Le dépôt local est déjà sur la branche `pre-fly`. Depuis le dossier du projet :

```bash
git remote add origin https://github.com/ClemenceDB/prefly.git
git push -u origin pre-fly
```

Pour activer le téléchargement de la landing :

1. Settings → Pages → Source : **GitHub Actions**.
2. Publier un tag : `git tag v1.0.0 && git push origin v1.0.0` — les installeurs sont attachés à la
   Release et la landing y fait automatiquement référence (`landing/app.js` interroge
   `/releases/latest`).

Les builds ne sont pas signés. macOS : clic droit → Ouvrir au premier lancement. Windows :
« Informations complémentaires » → « Exécuter quand même ».

## Licence

MIT — voir [LICENSE](./LICENSE).
