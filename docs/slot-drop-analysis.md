# Slot-Drop Timing Analysis — OFC Calendar Appearances

> Analysis performed 2026-10-19 on `logs/ofc-city-selections-*.txt` exports
> (10 profiles, Oct 12–19). **7,375 city-selection polls, 227 calendar sightings,
> ~90 fresh-drop episodes.** Revisit before changing `SPECIAL_WINDOW_TRIGGERS_SEC`.

## Method

Each `Selected CITY | Calendar Visible: true/false` line is timestamped when the
`getScheduleDays` response is captured — i.e., ~1–3s after the request, bounded by
the ~25s per-city poll cadence. A **fresh drop** = first `true` after ≥4min of
falses. For every episode the true release is bracketed inside
`(lastFalse → firstTrue]`; the tightest same-minute windows (9–22s apart) pin the
release second most precisely.

## Headline finding — drops are bimodal: **:26 and :56** past the hour

Episode-start minute histogram:

```
:26 ███████████████████ 19 ┐
:27 ██████ 6               │ 31 episodes
:28 ████ 4                 │
:29 ██ 2                   ┘
:56 █████████████████████ 21 ┐
:57 ███████ 7              │ 31 episodes
:58 ███ 3                  ┘
```

- **69% of all openings start in minutes 26–29 or 56–58** (~30min apart).
- Every other minute: 1–3 episodes — cancellations/re-releases, not scheduled drops.
- Drops occur at all hours; the 14:00–16:00 peak in the data is run-time bias.
- Median episode duration is ~one poll cycle — most calendars vanish/get consumed
  in well under a minute. Early detection matters.

## Release second — bracketed windows

Tightest same-minute windows (release ∈ `(lastFalse, firstTrue]`):

```
:56 drops: (02→17) (05→21) (06→22) (13→23) (02→24) (15→30)  → ~:56:05–:56:20
:26 drops: (06→15) (07→17) (10→20) (16→53) (19→28)          → ~:26:05–:26:28
```

- The release lands **inside** minute :26/:56 (proven — 11+ windows where the flip
  happened strictly after :26:0X), mostly within the first **:05–:25** seconds.
- No single fixed second-of-minute satisfies all windows → ~±15s jitter, either in
  the release itself or in server-side propagation (10–25s).
- The literal-`:58` trigger model is **not** supported above chance level
  (~40s windows cover any given second ~65% of the time; :58 covered 64%).

## Versus the current implementation

`SPECIAL_WINDOW_TRIGGERS_SEC` = :58 of minutes `{12,25,29,36,49,55,59}`.

- `:25:58` and `:55:58` sit at the leading edge of the two real drops — keep.
- `:12,:29,:36,:49,:59` have almost no historical support (cancellation noise).
- **Gap:** if the release lands ~:26:10–:26:25, a selection fired at :25:58 gets
  its response ~:26:00 — *before* the calendar opens. Next catch is +25s →
  ~12s late into a <60s-lived window.

## Recommended trigger times

| Priority | Fire city selection at | Rationale |
|---|---|---|
| Primary | **HH:25:58** and **HH:55:58** | Catches any leading-edge release; response lands ~:26:00/:56:00 |
| Secondary | **HH:26:18** and **HH:56:18** | Response lands ~:26:20/:56:20 — covers the common late-propagation releases the brackets show |

Single-shot per drop: **:26:03 / :56:03** (response ~:26:05–08; next natural poll
~+25s still inside the live window).

## Caveats

- Poll cadence (~25s/city) bounds detection resolution; release second is provably
  inside :26/:56 minutes, mostly :05–:25 — tighter pinning needs faster sampling
  or wire timestamps of the getScheduleDays response bodies.
- Non-peak episodes (:52, :43, :32, :36…) are real but rare — opportunistic.
- Data spans Oct 12–19, 2026; site behavior may shift — re-derive periodically.
