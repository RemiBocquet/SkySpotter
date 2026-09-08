# SkySpotter — ancienne adresse

Ce dépôt ne contient plus l'application. Il ne sert qu'à publier, via
GitHub Pages, une page de renvoi vers la nouvelle adresse :

**<https://skyspotter.remibocquet.fr>**

L'application est désormais hébergée sur un Raspberry Pi, qui sert aussi
de relais pour les API ADS-B (même origine que la page, donc pas de CORS
ni de proxy tiers). Son code vit dans un dépôt séparé et privé :
`RemiBocquet/skyspotter-app`.

## Contenu

| Fichier | Rôle |
| --- | --- |
| `index.html` | Page de renvoi + marche à suivre pour réinstaller la PWA |
| `404.html` | Même page, pour toute URL profonde de l'ancien site |
| `icon-*.png` | Icônes conservées pour l'affichage de la page |

La page n'inclut volontairement **pas** de `manifest.json` : cette adresse
ne doit plus être installable. Elle ne redirige pas automatiquement non
plus — quelqu'un qui a installé l'ancienne PWA doit la réinstaller depuis
la nouvelle adresse, ce qu'une redirection dans la fenêtre standalone ne
lui permettrait pas de faire.
