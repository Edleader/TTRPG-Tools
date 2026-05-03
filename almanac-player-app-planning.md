# Almanac Player App — Planning Notes

## Context

The GM already has a working **Almanac** tool — a local browser app (Chrome/Edge only, uses File System Access API) for running a TTRPG campaign. It reads markdown files from a local folder structure containing arc/chapter files, character notes, and player stats. The system is card-based: players have Active Slots (cards available to use) and Hand Slots (cards owned but not active).

The goal is to build a **player-facing digital app** to replace physical player mats and cards, while keeping the GM in control of card distribution and game state.

---

## File Structure (Existing + Planned)

```
/
├── campaigns/
│   ├── shadow-vale/
│   │   ├── players/
│   │   │   ├── fat-tony/
│   │   │   │   ├── player.md        ← stats, level, perks, slots, pin, session flags
│   │   │   │   └── cards/
│   │   │   │       ├── dagger.md
│   │   │   │       └── smoke-bomb.md
│   │   │   └── billy-cross/
│   │   │       ├── player.md
│   │   │       └── cards/
│   │   ├── cards/                   ← GM master card library for this campaign
│   │   ├── arcs/
│   │   └── campaign-overview.md
│   └── dragon-coast/
│       └── ...
├── rules.md                         ← shared across all campaigns
├── index.html                       ← DM Almanac app
├── app.js
└── style.css
```

---

## Architecture Decision: GitHub + Firebase

### Why GitHub

- Free account is sufficient — no paid tier needed
- Repository storage is just regular file storage; "Packages" (500MB limit noted on free tier) is an entirely separate thing for distributing software libraries — irrelevant here
- All files are `.md` and `.js`/`.css` — well under 1MB total even with many campaigns
- GitHub Contents API allows read **and** write via authenticated `fetch()` calls — no special backend needed
- GitHub Desktop provides a simple GUI; "commit and push" is the equivalent of "save and sync to OneDrive" — manual rather than automatic but fine for this use case

### Why Not Just GitHub (The Polling Problem)

GitHub has no push/notification capability. Apps can only ask "has anything changed?" — polling. Even polling every 3–5 seconds feels sluggish for live HP tracking during combat. A better solution is needed for real-time state.

### The Two-Layer Solution

| Layer | Stores | When |
|-------|--------|------|
| **GitHub** | Cards, stats, perks, levels, slot counts, session_active flag | Persistent — survives between sessions |
| **Firebase Realtime Database** | Current HP, lock/unlock states, trade requests, active campaign signal | Volatile — live session state, instant updates |

**Firebase** provides genuine WebSocket connections — changes push to all connected apps in under a second with no polling. The free **Spark plan** is genuinely free forever and covers: 1GB storage, 10GB/month transfer, 100 simultaneous connections. With 6 players you will never approach these limits.

### How They Work Together

- Firebase is the **live whiteboard** for the current session
- GitHub is the **source of truth** that persists between sessions
- HP writes to Firebase instantly (all apps update live), then debounces and also writes to GitHub a few seconds later — silently, in the background, no user action required
- Neither layer replaces the other

---

## Authentication & Accounts

- **Players:** no accounts needed whatsoever. Firebase supports open read/write to specific paths with no authentication. Players just open a URL
- **DM Almanac:** GitHub token and Firebase config are baked into the app's JavaScript as config values. They load automatically — no login step
- **Firebase API keys** are deliberately designed to be public-facing (security is controlled by Firebase Rules on paths, not by hiding the key). Having it in client-side JS is fine and intended
- **GitHub token** gives read/write access to the repo. Should be a read-only token for the player app, read/write for the almanac

---

## Multi-Campaign Support

Firebase uses a nested JSON path structure. One Firebase project handles all campaigns:

```
/campaigns/shadow-vale/session/fat-tony/hp: 24
/campaigns/dragon-coast/session/other-character/hp: 30
```

No separate Firebase project per campaign needed.

### Campaign Selection Flow

- **Player app** has a "Select Campaign" dropdown (reads campaign list from GitHub repo structure) and a "Select Character" dropdown filtered to players within that campaign
- **Between sessions:** player app is fully functional without the DM app running — players select campaign and character themselves
- **During a session:** the DM almanac writes `active_campaign: shadow-vale` to Firebase; player apps could optionally inherit this, but the dropdown remains available as fallback

---

## Character PIN Protection

Not full security — just enough to prevent casual wrong-character access or snooping between friends.

Add a `pin` field to `player.md`:

```yaml
name: Fat Tony
player: Tony
pin: 1234
```

Player selects campaign → selects character → app prompts for PIN → correct PIN unlocks the sheet. The files remain technically readable via the API if someone went looking, but this is the appropriate level of protection for a home game.

---

## Session State & Read-Only Mode

`session_active` is stored in GitHub (persists between sessions, not just Firebase).

```yaml
session_active: false
```

When `false`, player apps render in **read-only mode** — everything visible, nothing interactive. When `true`, full interactivity enabled.

The DM almanac has **Start Session / End Session** buttons:

**Start Session:**
- Reads current state from GitHub, pushes to Firebase
- Sets `session_active: true`
- Player apps activate

**End Session:**
- Sets `session_active: false`
- Player apps drop to read-only
- Any final state already written to GitHub via background autosave

HP and volatile values are autosaved to GitHub continuously via debouncing (waits ~2–3 seconds after last change, then writes once) — so End Session is not required for saving, it's a deliberate GM action to transition game state.

---

## Card Management Rules (from rules.md)

Players can move cards between Hand and Active slots only during:

- **Long Rest** — unlimited swaps
- **Short Rest** — up to half of active cards (round down); max 2 short rests per day, must be separated by a combat
- **Tactician perk (Level 5)** — once per combat, spend Hand card use to swap one active ↔ hand card mid-fight

### GM Lock/Unlock System

Player card UIs are **locked by default** — hand↔active movement disabled.

DM has per-player (or party-wide) unlock controls in the almanac:

- **Short Rest unlock:** grants movement up to the swap limit, counts swaps, auto-locks when limit reached
- **Long Rest unlock:** grants unlimited movement
- **Manual override:** DM can force-lock at any time

Lock/unlock state flows through Firebase — player apps update near-instantly when DM presses the button.

---

## GM Card Distribution

In the almanac, when a card file is open:
- "Give Card" button → choose player → GitHub API call creates a copy of the card in `/campaigns/shadow-vale/players/fat-tony/cards/`
- Player's app sees new card on next refresh or Firebase-triggered update

"Giving a card" in the file sense = committing a new `.md` file to the player's cards folder. Removing = deleting the file.

---

## Player-to-Player Card Trading

Players can request trades in their app. DM sees pending trade in the almanac and approves with one click. On approval:
- Card file copied to recipient's folder
- Card file deleted from sender's folder
- Both apps update

Players have no direct write access — all trades are GM-mediated. Appropriate for a home game and gives the GM narrative awareness of what's being traded.

---

## Levelling Up

DM presses "Level Up" next to a player in the almanac. Player app shows a notification and walks them through:

- Distribute new stat points (app enforces caps from rules.md)
- Choose a perk if they hit level 5, 10, or 17 (app only shows eligible perks based on current stats)
- Extra card slots granted automatically

On confirmation, `player.md` is written back to GitHub with updated values. DM's almanac player panel refreshes automatically.

---

## Almanac Migration

The existing almanac uses the **File System Access API** — Chrome/Edge only, local filesystem. Migrating to read from the **GitHub Contents API** instead means:

- Works in **Firefox, Safari, mobile browsers** — any browser
- Can be hosted online (GitHub Pages — free, same repo)
- DM no longer needs files locally at all beyond the app itself
- Player app and DM app read from the same source of truth

Recommended approach: keep the existing local almanac working as-is while building the new version, migrate when stable.

---

## Suggested Build Order

1. Set up GitHub repo with existing file structure
2. Migrate almanac to read from GitHub API (unlocks Firefox, makes it hostable)
3. Build player-facing character sheet app (read-only first)
4. Add Firebase layer for live HP and lock states
5. Add GM card-give tool to almanac
6. Add trade request system
7. Add levelling UI (most complex — design carefully, rules.md is the spec)

---

## Tools & Accounts Needed

| Tool | Cost | Purpose |
|------|------|---------|
| GitHub (free account) | Free | File storage, version history, API |
| GitHub Desktop | Free | GUI for managing local ↔ cloud sync |
| GitHub Pages | Free (included) | Hosting the web apps |
| Firebase (Spark plan) | Free forever | Real-time live session state |
| Claude / Claude Code | — | Building and iterating on the apps |

**Zero accounts or installs required for players.** They open a URL.

---

## Open Questions / Deferred

- Between-session player experience needs more thought (partially resolved by campaign/character dropdowns, PIN, and read-only mode)
- Exact `player.md` schema to be finalised (needs fields for: stats, level, perks, slot counts, pin, session_active, swap_lock, swaps_remaining)
- Card `.md` file schema to be defined
- Whether cards master library is campaign-specific or shared across campaigns
