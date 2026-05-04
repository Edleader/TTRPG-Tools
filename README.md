# TTRPG Tools

GM and player toolset for running the campaign. Built with plain HTML/CSS/JS, GitHub as persistent storage, and Firebase for live session state.

---

## Live URLs

| Tool | URL |
|------|-----|
| **DM Almanac** | https://edleader.github.io/TTRPG-Tools/dm/ |
| **Player App** | https://edleader.github.io/TTRPG-Tools/player/ *(coming soon)* |

---

## Admin links

| Service | Purpose | URL |
|---------|---------|-----|
| **GitHub repo** | All campaign data, card files, and app code | https://github.com/Edleader/TTRPG-Tools |
| **GitHub Pages** | Hosts both web apps (Settings > Pages) | https://github.com/Edleader/TTRPG-Tools/settings/pages |
| **GitHub PAT** | Personal access token for repo read/write | https://github.com/settings/tokens?type=beta |
| **Cloudflare Worker** | API proxy that keeps the GitHub token secret | https://dash.cloudflare.com/ (Workers & Pages > ttrpg-github-proxy) |
| **Firebase Console** | Realtime database for live session state | https://console.firebase.google.com/project/ttrpg-livespace |

---

## How it works

- **Campaign data** lives in `campaigns/[campaign-id]/` as `.md` files with YAML frontmatter
- **Cards** live in `campaigns/[campaign-id]/cards/[type]/[card-name].md`
- **Player sheets** live in `campaigns/[campaign-id]/players/[name].md`
- **Player card inventories** live in `campaigns/[campaign-id]/players/[name]/cards/`
- **DM notes** are stored alongside chapter files as `[filename].dm.md` — visible only in the DM app
- **GitHub token** is stored as an encrypted secret in the Cloudflare Worker — never in the repo
- **Firebase** handles live HP, lock/unlock states, and session signals during play

---

## Repo structure

```
/
├── dm/                  — DM Almanac app
├── player/              — Player app (in development)
├── shared/              — Shared JS utilities (GitHub API, config)
├── campaigns/
│   └── campaign-01/     — "The Anomaly"
│       ├── players/     — Player character sheets + card inventories
│       ├── cards/       — Master card library (weapons, spells, armour, abilities, items)
│       ├── characters/  — NPC files
│       ├── arc1/ … arc7/— Story arcs and chapters
│       └── campaign.md  — Campaign metadata
└── rules.md             — Full system rules
```
