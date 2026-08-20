# Live Ladder

A desktop app for running a live AFL ladder on game day. Connect the round's
scoring feeds once, then leave **LIVE** on screen for the afternoon.

```bash
npm install
npm start
```

---

## Game day, start to finish

1. **LADDER** — paste the ladder entering the round, press **Load ladder**.
2. **SOURCE** — paste each game's scoring link, press **CONNECT ALL**.
3. Check every card reads **CONNECTED** and shows the right two teams.
4. **LIVE** — leave it running.

Keyboard: `1` SOURCE, `2` LADDER, `3` LIVE, `F11` full screen.

---

## Sources

| Source | What it reads | Browser needed |
|---|---|---|
| **Record2020 / GameFace** | `/Api/Fixture/GetFixtureScoreForCode/<code>` + `/Api/Competition/GetSharedTeams/<code>` — the same JSON the live page itself loads. Quarter-by-quarter goals and behinds are summed into the running score. | No |
| **Custom Scorebug** | `GET <origin>/state` — the scorebug's own state document, including the game clock. | No |
| **Manual** | Whatever the operator types. | No |
| **Demo — rehearsal** | A simulated round, for practising the flow out of season. Clearly labelled; reads nothing. | No |

Both live sources publish JSON, so the normal path is a plain HTTP read: nothing
flashes on screen and five games cost almost nothing to poll.

If either endpoint ever changes shape, the adapter falls back to reading the
**rendered page** through an offscreen Chromium window (Electron's own engine —
`show:false`, `offscreen:true`, never visible, never in the taskbar). The card
shows `VIA PAGE` when that happens, so you always know which path is in use.

Adding another source is one file in `main/adapters/` that returns the shared
game object; nothing downstream changes.

---

## Ladder maths

4 points a win, 2 a draw, 0 a loss. Percentage is points for ÷ points against
× 100, recomputed live from the F and A columns in your paste. Ordered by
points, then percentage, then points for.

A game only counts once it has started — a scheduled fixture sitting at 0-0 is
excluded, because projecting it as a draw would hand both clubs two points they
have not played for.

**Paste format.** Column meaning comes from the header row, so extra or
reordered columns are fine. Both the two-block layout (names, then numbers) and
a single-block layout work:

```
#	Team
1	Chelsea FNC Senior Men
2	Somerville FNC Senior Men
…

P	PTS	%	W	L	D	BYE	F	A	FORF	DISQ	ADJ
18	60	176.62	15	3	0	0	2017	1142	0	0	0
18	56	151.45	14	4	0	0	1669	1102	0	0	0
…
```

**Check paste** parses without saving and warns if F/A does not reproduce the
published percentage — a quick way to catch a bad copy before the first bounce.

---

## Matching games to clubs

Feeds and ladders never agree on naming (`Bonbeach` vs `Bonbeach FNC Senior
Men`), so each connected game is matched to ladder clubs automatically — exact,
then containment, then a tolerant token match. Anything it cannot resolve is
left explicit: the SOURCE card highlights the club dropdowns and the LIVE card
says **NOT ON THE LADDER**. Nothing is silently guessed onto your ladder.

---

## What counts as an event

| | |
|---|---|
| **Goal** | Local to that game card: sweep, score pop, GOAL chip. Nothing else moves. |
| **Ladder position change** | The major event — the row lifts toward you in 3D, travels past the rows it passed, glows, settles, and logs a line. |
| **Percentage movement** | Silent. Percentage churns constantly; it is not news until a club actually changes position. |

Detection compares explicitly held previous state, never rendered output:

- the first ladder seen only seeds state, so opening the app never produces a burst of phantom movement
- the first read after connecting only seeds state, so connecting is never read as a goal
- reconnecting forgets that game's score history, so a reconnect is never read as a goal
- a club oscillating across a percentage boundary cannot spam the log with the same move

---

## Reliability

- Each source has its own health state: **connected / stale / error / manual**.
- Reads run concurrently and independently; one dead source cannot stall, freeze or crash the others.
- A failed read never wipes the last good score. The score stays on screen and only the health indicator degrades — amber when a feed goes quiet, red when it has failed repeatedly.
- **Manual override** takes over any game, seeded with the last known live values so the ladder does not lurch. Switch back to automatic whenever the feed returns.
- Startup is deliberately cold: links, source types, club mappings and manual values are all restored, but nothing is treated as live until you press Connect.
- Config lives in `%APPDATA%/Live Ladder/live-ladder.json`.

---

## Scripts

```bash
npm start        # run the app
npm run demo     # rehearsal mode: simulated round, separate config profile
npm run selftest # parser, matching, ladder maths, event detection + a live read of both sources
npm run livecheck # connect the real feeds headlessly and print what LIVE would show
npm run icon     # rebuild build/icon.ico from build/icon.svg
npm run dist     # package for Windows (needs electron-builder)
```

---

## Layout

```
main/
  main.js              window, IPC, demo seeding
  preload.js           the only surface the UI gets
  adapters/            record2020 · scorebug · manual · demo
  engine/
    gameStore.js       slots, polling, health, snapshots
    ladder.js          ladder maths (pure)
    ladderParser.js    paste -> clubs
    events.js          position / goal / final detection
    teams.js           club name normalising and matching
  lib/                 http · model · store · browserPool
renderer/
  index.html
  css/                 app · source · live
  js/views/            source · ladderSetup · live
```

Data flows one way: **adapters → normalised game → game store → ladder engine →
event detection → UI**. The renderer has no network access and no Node; it draws
snapshots pushed from the main process.
