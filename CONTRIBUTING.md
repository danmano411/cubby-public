# Contributing to Cubby

Thanks for helping. The easiest contribution is a catalog entry for an app Cubby does not know yet;
the next easiest is a bug report with your monitor setup in it.

## Run it

Requires [Node.js](https://nodejs.org/) 22 or newer.

```bash
npm install
npm start          # run from source
npm run check      # unit tests (node --test), must pass
npm run smoke      # opens every window on every connected display, then exits 0 or 1
```

`npm run smoke` uses its own temporary data folder, so it never touches a Cubby you have running or
your real config. It does not need keyboard or mouse input.

Environment variables:

| Variable | Effect |
|---|---|
| `CUBBY_DEBUG=1` | Print a timestamped log to the terminal. Attach it to bug reports. |
| `CUBBY_VOICE_WAV=<file>` | Feed a WAV file to the voice recognizer instead of the microphone, for testing phrases. |

## Layout

```
src/
  main.js            app lifecycle, tray, windows, IPC. Platform-agnostic.
  model.js           pure: turns the config plus the open windows into what the UI shows.
  session.js         Open All / Kill All.
  layout.js          pure: where the tray, panels, toasts and cue go on a given display.
  config/            schema (defaults, validation, migration) and the app catalog.
  music/             music player providers.
  features/          optional features that plug into main.js through a ctx object.
  platform/
    index.js         picks windows/ or mac/ by process.platform.
    windows/         koffi bindings plus PowerShell helpers.
    mac/             the macOS adapter; everything native goes through native/mac-helper.
  *.html, *.js, *.css   the renderer windows (tray, side panels, toast, voice cue, setup).
native/mac-helper/   the macOS helper process (Swift). Build steps in its README.
test/                node:test files and a fixture config with made-up apps.
build/               electron-builder resources (icon).
assets/              logo and README images.
scripts/             icon renderer and the privacy check.
```

The rule that keeps the two platforms honest: **everything OS-specific lives behind
`src/platform/`**. `main.js`, the model and the renderers call the adapter and never `process.platform`
(apart from labels). A new adapter function must exist in both `windows/` and `mac/`; until the macOS
side is written it should throw "not implemented yet" so the gap is loud.

## Pull requests

- Keep `npm run check` and `npm run smoke` passing.
- Match the surrounding style: small plain-JS modules, no frameworks, comments that explain why and
  not what. Please do not add a dependency without a good reason in the PR description.
- Add a test for pure logic (`model`, `layout`, `schema`, catalog). Platform code is checked by hand;
  say what you ran it on.
- Anything that touches placement of windows needs a note on which monitor setups you tried. The usual
  traps are mixed scaling (150% beside 250%), monitors above or to the left of the primary (negative
  coordinates), and screens that are plugged in or removed while Cubby runs.
- **No personal data in the repo.** No real names, account or tenant ids, machine paths or your own
  config, in code, tests, fixtures or docs. Use made-up apps in tests. CI runs a privacy check.

## Adding an app to the catalog

Edit `src/config/catalog/windows.json` and/or `mac.json`, one line per app:

```json
{ "id": "example", "name": "Example", "category": "Utilities", "match": { "exe": "example.exe" }, "launch": { "appId": "Example.App" } }
```

- `id`: lowercase, the same on both platforms where the app exists on both.
- `category`: one of the existing ones if possible (Social, Browsers, IDE, Notes, Music, Utilities).
- `match`: how to recognise the app's running windows. Windows: `exe`, and `title` (a regular
  expression) for apps that run under a generic host such as `java.exe` or `pythonw.exe`. macOS: `bundleId`.
- `launch`: how to start it. Windows: `appId` (find it with `Get-StartApps` in PowerShell), `exe` (a path;
  `%APPDATA%`-style variables work) or `uri`. macOS: `bundleId`.
- Optional: `badgeOffset` (apps whose taskbar count includes something that is not a message), `tint`,
  and `note` for a quirk worth explaining.

If the launch id contains a version number, leave `launch` out and say so in `note`; users can set it in
`config.apps.<id>`.

## Reporting a bug

Use the issue template. The most useful things are your OS version, the Cubby version, the debug log
(`CUBBY_DEBUG=1`), and for anything about positioning: how many monitors, their scaling and their arrangement.

## License

By contributing you agree that your work is released under the [MIT license](LICENSE).
