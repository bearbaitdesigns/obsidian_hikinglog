# Hiking Log for Obsidian

A trail journal for your vault: log every hike as a diary entry with photos, a rating, stats and notes — then browse it all on an outdoorsy dashboard.

## Install

**With BRAT (recommended):** install the *BRAT* community plugin, then run *BRAT: Add a beta plugin for testing* and paste this repository's URL. BRAT installs Hiking Log and keeps it updated.

**Manually:** download `main.js`, `manifest.json` and `styles.css` from the latest release into `.obsidian/plugins/hiking-log/` in your vault, then enable **Hiking Log** under **Settings → Community plugins**.

No build step needed — `main.js` is plain JavaScript.

## Releasing an update

1. Bump `version` in `manifest.json` (and add it to `versions.json`).
2. Commit, then push a tag with exactly that version, e.g. `git tag 1.0.1 && git push origin 1.0.1`.
3. The *Release plugin* GitHub Action publishes the release; BRAT picks it up automatically.

## Folder layout

Every hike gets its own folder inside `Hikes/`, holding the note and its photos:

```
Hikes/
  2026-11-08 Eagle Peak/
    2026-11-08 Eagle Peak.md
    IMG_2041.jpg
    IMG_2044.jpg
  2026-10-19 Lakeside loop/
    2026-10-19 Lakeside loop.md
    summit.jpg
```

**Any image you put in a hike's folder shows up in its gallery automatically** — drag photos into the folder in the file explorer, or drop them straight onto the gallery in the note.

Tip: set **Settings → Files and links → Default location for new attachments** to *Same folder as current file*, so photos pasted into a hike note also land in its folder.

Hikes from an older version (all notes in one `Hikes` folder) keep working. Run *Move current hike into its own folder* to upgrade one — its photos move with it. Adding photos to an old hike does this automatically.

## Use it

- **Log a hike:** ⛰ ribbon icon → **Log hike**, or *Hiking Log: Log a new hike*. Name, date, location, type, route (loop, out and back, point to point), difficulty (easy, moderate, difficult, extreme), 1–5 star rating, distance, time, elevation, calories, weather, companions, photos, diary and notes.
- **Back to the dashboard:** the **← Dashboard** button at the top of every hike note.
- **Change the cover photo:** hover a photo in the gallery → **Set cover**; or in the full-size viewer → **Set as cover**; or the 🖼 button on the hike card (also the *Change cover photo* command), which lets you pick any photo or choose no cover.
- **Older notes with a "Diary" heading:** the plugin removes it automatically when Obsidian starts (there's also a *Remove the "Diary" heading from all hike notes* command). New hikes never have it.
- **Favorite a hike:** the ♥ on the hike card, the *Favorite* switch in the hike form, or *Toggle favorite on current hike*. Stored as `favorite: true`.
- **Edit stats / add photos:** the ✏️ on the hike card, or *Edit stats / add photos to current hike*.

## A hike note

```markdown
---
tags: [hike]
title: Eagle Peak
date: 2026-11-08
location: Eagle Peak, Cascades
hike_type: Summit
route_type: Out and back
difficulty: Difficult
rating: 5
distance: 14.2
duration: "5:10"
elevation: 1120
calories:
weather: Clear, 8°
companions: Sam
cover: "[[Hikes/2026-11-08 Eagle Peak/IMG_2041.jpg]]"
---
```hike-card
```

Your diary entry goes here, straight under the card…

## Notes
…

## Photos
```hike-gallery
```
```

- `hike-card` renders the cover, then the title, date, location, type, stars and a stat grid (distance, time, elevation, calories, pace) over a greyscale contour-map background that's unique to each hike, with dashboard-style stat cells.
- `hike-gallery` renders every photo in the hike's folder as a grid of equal-size tiles. Click a photo for a full-size viewer with ←/→ navigation. You can also list extra image paths inside the block to include photos stored elsewhere.
- **Arrange** (gallery header) lets you drag photos into a new order or use the arrows, and delete photos with the bin. Deleted photos go to Obsidian's trash; the order is saved as `photo_order` in the note's properties.
- `cover: none` hides the cover; with no `cover` set, the first photo is used.

**Route** and **difficulty** can also be typed into the note's properties; common variants like `out & back`, `p2p`, `hard` or `medium` are understood.

**Duration** accepts `3:45`, `3h 45m`, `45m`, or minutes. Blank **calories** are estimated (shown with `~`) from time, distance, elevation, type and your body weight.

## Dashboard

- Banner with ridgeline art, year/type filters and **Log hike**
- Totals on one row: hikes, distance, time on trail, elevation gain, calories, average rating (they shrink to fit narrow panes)
- Monthly chart (distance, elevation, time, calories or hike count)
- Personal records, full width under the chart: longest hike, most climbing, longest day, most calories, top rated
- Breakdown panels in two rows of three: hike types, route types, difficulty; ratings, top locations, favorites
- Your 5 most recent hikes as photo cards, and a sortable log of every hike (♥ marks favorites)

Light and dark mode both get an earthy forest / moss / clay palette in frosted-glass panels over a greyscale contour map. The map is drawn once and stays put while you scroll — it never repeats.

## Settings

Hike folder, metric/imperial units, body weight, calorie estimates on/off, open-after-logging, and your own list of hike types.
