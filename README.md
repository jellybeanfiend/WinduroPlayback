# Winduro race playback

[Open the Winduro race viewer](https://jpathome.github.io/WinduroPlayback/).

Explore participant GPX tracks around the island course with synchronized playback, an interactive map, and absolute or relative time.

## Run locally

From the project directory, start Python's static server:

```powershell
python -m http.server 8000
```

Open [http://localhost:8000](http://localhost:8000). Press `Ctrl+C` in the terminal to stop the server.

## Using the viewer

- Choose **Absolute** to follow event clock time or **Relative** to align riders at the sync-line crossing.
- Use **Play**, **Reset**, the race-position slider, and playback-speed control to navigate the race. Pan and zoom the map to inspect the course.
- The map leaderboard starts collapsed. It shows fixed completion-time order in **Absolute** mode and live counterclockwise two-center angle ranking in **Relative** mode, including checked participants; use its top-right button to expand or collapse the list.
- Expand **Advanced settings** to pin names, show full routes, hold position through detected GPS dropouts, or draw and adjust the relative-time sync line.
- Select participants in the list to show or hide their tracks. Use **Show all details** to view gear, start and finish times, and timing information for every participant.
- Choose a race from the **Race** selector. Race-specific links use the `race` query parameter; changing races resets playback and other race-specific URL settings.

## Track timing

Tracks with timestamps use their recorded times. For tracks without point timestamps, start time and duration are used to estimate positions between recorded points. This timing is approximate and cannot reproduce exact pauses or synchronization.

Completion times are calculated once from the manifest's default sync line: from its synced start to the first later crossing at least 30 minutes afterward. If no qualifying crossing exists, the track end is used. Moving the playback sync line does not change participant times.

The race catalog is `races.json`. Each entry has a unique lowercase `id`, a display `name`, and a `manifest` path. Each race manifest contains participant details, gear, timing estimates, track colors, and its default sync line. GPX filenames are relative to that manifest and must be in the same directory. The existing race uses `tracks/tracks.json`; add future races in separate directories, for example `races/<race-id>/race.json` with that race's GPX files beside it. Set `color` and optional `secondaryColor` to six-digit hex values; secondary colors appear in participant swatches and marker outlines, while routes stay in the primary color. **Timing for untimed tracks is estimated.**

## Contributing track data

Before opening a PR, run `python scripts/validate_tracks.py`. GitHub Actions runs the same check for every PR. The validator checks the race catalog, every race manifest, and each referenced GPX file. Participant names and primary colors must be unique within a race; `secondaryColor` is optional.

For a timestamped track that needs a manual crossing at the default sync gate, set top-level `startTime` to the intended ISO 8601 timestamp. The override is ignored for non-default gates, where crossings are recalculated from the GPX route. For tracks without point timestamps, put estimated timing in a `timing` object with `start` and `durationSeconds`.

## Map and data

The map uses [Leaflet 1.9.4](https://leafletjs.com/reference-1.9.4.html) and Esri World Imagery. Imagery attribution is shown on the map; review [Esri's World Imagery terms](https://goto.arcgisonline.com/maps/World_Imagery) and [data attribution guidance](https://www.esri.com/en-us/legal/terms/data-attributions).

This public site includes participant GPX tracks and precise route locations. The participants have approved their publication.
