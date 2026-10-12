# Atrium

English · [简体中文](README.md)

Downloads and version-specific release notes are available on [GitHub Releases](https://github.com/jhlxlml/Atrium/releases).

Atrium is a local image browser for Windows: pick a folder and browse your photos the way you would flip through a portfolio. The name means *atrium* — the place where daylight falls from above and lights up the whole display space, and a photo wall is exactly that.

It does one thing: open a local folder and let you look at, and tidy up, your pictures comfortably. No account, no cloud sync, no telemetry, **zero runtime third-party dependencies**, and identical behaviour with the network unplugged.

![Atrium grid view: four layouts, filename search, favourites-only, privacy mode and multi-select](docs/images/grid.png)

*Grid view. The 24 samples in the screenshot are synthesised on the fly by `?demo=1`, not real photos.*

![Atrium lightbox: zoom, rotate, fullscreen, slideshow, EXIF and favourites](docs/images/lightbox.png)

*Lightbox, with the zoom level, rotation, EXIF, favourites and slideshow controls along the bottom.*

There is exactly one delivery form: a **portable Electron build**. Unzip and run, no installation. The earlier "offline single-file HTML" build was retired in v1.13.0; its build script, regression suites and every browser fallback in the renderer were removed.

The repository holds source code only and **does not include the release ZIP** (~112 MB, already in `.gitignore`). Build it yourself with the steps below if you need it.

## Features

### Browsing and loading

- Four layouts: small, medium, **masonry** and single column. The top-bar icons, the settings panel, the number keys `1`–`4` and `M` to cycle all drive the same value.
- Masonry assigns to the shortest column, column width is adjustable (120–420 px), and columns are re-balanced to fill the container exactly. Long lists are virtualised, so scrolling stays smooth.
- Native folder picker, **drag-and-drop into the window** (folders or loose images), and it remembers the last folder. Dropped items carry no disk path, so indexing, thumbnails, lightbox and deletion each handle that path separately.
- Thumbnails are **cached on disk**: reopening a folder decodes nothing, roughly a 5× speed-up. The size index stores true original dimensions, read from file headers rather than by decoding.

### Lightbox and frame mode

- Lightbox: zoom, pan, rotate, fullscreen, slideshow, filmstrip, EXIF, favourites, delete — with proper dialog semantics and a focus trap.
- **Frame mode**: a borderless standalone window that reshapes itself to the image's aspect ratio, can be dragged and moved between displays, and recovers the main window if the renderer crashes.

### Deletion and recovery

- Deletion goes to the **system recycle bin** and is recoverable. `Ctrl+Z` undoes it, and there is a recycle-bin view backed by a local JSON log.
- Capability is probed in three tiers — when recoverable deletion is not available, the app **says so** instead of pretending it worked.

### Organising and searching

- Search by filename, favourites, favourites-only filter, multi-select.
- Export selected images, with **rotation actually baked into the pixels** rather than written as an EXIF orientation tag.
- Privacy mode: blur every image at once, for screen sharing or recording.

### Supported formats

- JPEG, PNG, GIF, WebP, BMP, AVIF, SVG, ICO, TIFF.
- **HEIC/HEIF is capability-probed**: it works if the system has an HEVC decoder, and is clearly marked unavailable if not — never rejected unconditionally. The probe runs once and is cached.

### Desktop integration

Whatever the OS can do, the app does not redraw — native menu bar with accelerators, native context menu (**greyed out according to current state**), system tray, taskbar thumbnail buttons and progress bar, jump list, and a global hotkey.

One deliberate rule: **a menu item's id is the internal command id**, so a regression probe can take that command id and ask Electron which accelerator is actually bound — it tests the real assembly, not the string in my data file.

### Accessibility

Four layers are in place: screen-reader announcements (all 52 user-facing actions are announced, destructive ones use `assertive`), semantics with `aria-modal`, a focus trap shared by four containers, and full keyboard reachability plus reduced-motion and visible focus rings.

## Getting started

### Using the portable build

1. Unzip `Atrium_Electron版_v1.13.0.zip`.
2. Double-click **`Atrium.cmd`** (**not** `Atrium.exe`).
3. Click "添加文件夹" (Add folder), or drag a folder / images straight into the window.

> **Why a `.cmd` and not the exe**: WorkBuddy and some Node environments inject `NODE_OPTIONS`, which makes a packaged Electron app **exit immediately on launch**. The launcher clears that variable first, then starts the app. It looks for `Atrium.exe` by name and only falls back to "the first exe in the folder" if it is missing.

> The application UI is currently Chinese. This English README does not imply an English UI.

### Building from source

Requirements: **Windows** + Node.js (20 or newer recommended; tested on 22.x). There are no runtime dependencies — the two packages below are **build-time only**.

```bash
git clone https://github.com/jhlxlml/Atrium.git && cd Atrium

# 1. Install build-time dependencies (electron + rcedit, ~269 MB, gitignored)
cd deploy/electron && npm i && cd ../..

# 2. Build the portable package -> deploy/dist-electron/
npm run build

# 3. Package the ZIP -> repository root
npm run pack
npm run verify:zip      # independent CRC verifier + third-party 7-Zip re-check

# 4. Full regression (includes running the exe that was just packaged)
npm test
```

### Common commands

| Command | Purpose |
|---|---|
| `npm test` | Full regression: **28 suites / 346 assertions**, roughly 150–190 s |
| `npm run test:fast` | Quick pass: 11 suites / 51 assertions, ~8 s (**includes `tf`, which needs electron**) |
| `npm run build` | Build the portable Electron package |
| `npm run pack` | Produce the release ZIP |
| `npm run verify:zip` | Independent ZIP verification (CRC / structure / third-party re-check) |
| `npm run probe -- probe_grid.js` | Run a single Electron probe |
| `npm run shots` | Regenerate the two screenshots in this README |
| `npm run clean` | Remove regression runtime artefacts (once grew to 2.5 GB) |

> **`npm test` depends on build output**: the `appself` suite runs the real exe in `deploy/dist-electron/` (that is exactly what makes it the closest thing to a real user), and the `zip` suite reads the release ZIP in the repository root. **On a fresh clone, run `npm run build` (and `npm run pack`) before the full regression**, or those two suites will fail — not because the regression is broken, but because they **deliberately refuse to pass when the artefact is missing**. To check source-only changes, use `npm run test:fast`.

## Keyboard shortcuts

Press **`F1`** inside the app to open this table at any time. Its contents come entirely from what is actually bound — nothing "planned" is listed.

| Keys | Action |
|---|---|
| `Ctrl+O` | Open folder |
| `Ctrl+E` | Export selected images |
| `Ctrl+1` `Ctrl+2` `Ctrl+3` `Ctrl+4` | Small / medium / masonry / single column |
| `Ctrl+Plus` `Ctrl+-` `Ctrl+0` | Zoom in / out / reset tile size |
| `Ctrl+L` | Favourites only |
| `Ctrl+B` | Blur preview (privacy mode) |
| `Ctrl+T` | Always on top |
| `Ctrl+Shift+F` | Frame mode |
| `Ctrl+A` / `Ctrl+Shift+A` | Select all on page (in library / via menu) |
| `1` `2` `3` `4` / `M` | Switch layout / cycle layouts |
| `F` / `/` | Favourites only / search filenames |
| `+` `-` | Grow / shrink tiles |
| `Delete` | Delete selection (to recycle bin) |
| `Space` | In lightbox: next image |
| `F11` / `F1` | Fullscreen / shortcut reference |
| `Esc` | Clear selection / close panel / leave recycle-bin view |

Right-clicking an image opens a **native context menu** (open, previous / next, rotate, favourite, fullscreen, reveal in folder, export, delete, select all), greyed out according to the current state.

## Architecture

**Five layers, one-way dependencies** — an upper layer may depend on a lower one, never the reverse.

```
presentation  index.html · main.css / lightbox.css / frame.css
   ↑
interaction   app.js (events & command dispatch) · settings.js · grid.js · lightbox.js · frame.js
   ↑
state         state.js (single source of truth + event bus) · masonry.js / transform.js (pure)
   ↑
data          loader.js · thumb.js · exif.js · trash.js · util.js · a11y.js
   ↑
platform      native.js (renderer-side adapter) ──IPC──▶ preload.js (allow-list) ──▶ main.js / desktop.js
```

A few deliberate decisions:

- **Pure functions pushed downwards**: all geometry (layout, zoom, centring, rotation) is factored into DOM-free pure functions, so **807** fine-grained assertions run in milliseconds under Node without opening a window.
- **`desktop-spec.js` is pure data** (menu template, accelerators, command vocabulary) and is **not allowed to `require('electron')`** — which is why 76 assertions can test it directly under Node.
- **Security baseline**: `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, a custom privileged `vf://` protocol, a preload allow-list, and new windows / external navigation refused. Every desktop-integration IPC channel **verifies the sender**, and untrusted calls are rejected.

## Engineering and regression

The project tries hard to turn "potholes we fell into" into **mechanisms**. Current figures:

| Metric | Value |
|---|---|
| Regression | **28 suites / 346 assertions**, non-zero exit on any failure |
| Source size | `js/` 9,361 lines across 15 modules · `css/` 1,788 lines across 3 files · `index.html` 373 lines · main-process side 2,782 lines |
| IPC | 33 invoke + 1 renderer→main + 3 main→renderer = **37 unique channel names** |
| Runtime dependencies | **0** (`electron` and `rcedit` are build-time only) |

Several layers of the regression are **mutually independent lines of defence**:

- **Runs the real artefact**: `appself` launches the **exe that was packaged into the build** and walks the whole chain — boot, index, decode, delete, restore, batch, marquee, lightbox, EXIF, always-on-top.
- **Verifiers ship with reverse gates**: the ZIP CRC check uses Node's native `zlib.crc32` as its reference (**a different source from the writer under test**) and deliberately constructs corrupt archives to prove it really rejects them. The icon verifier **does not reuse the generation code** — verifying yourself against yourself proves nothing.
- **Byte-level evidence**: verifying the exe icon is not "the build didn't error", it is taking the bytes of the 7 embedded PNGs inside the `.ico` and looking each one up with `exe.indexOf` — all 7 hit, and the same 16 px PNG is `-1` in the stock `electron.exe`.
- **Source-level invariants**: the `frozen` suite pins strings that would **wipe user data if changed** (`vf://app`, three `localStorage` keys, `viewfinder-db`, `com.atrium.app`, `productName`); the `ipcchain` suite checks that every channel exposed by the preload has a handler — miss one and you get a **silent degradation**.
- **Failures explain themselves**: assertion messages carry field evidence such as "how many announcements fired, and what the last one said", instead of just `false`.

> **On the number**: `346` counts **suite-level entries**. Six pure-function suites expand into far more fine-grained assertions internally (807 in total) but are counted as one entry each — so **do not add them up**.

## Repository layout

```
Atrium/
├─ index.html            App shell (with an inline SVG icon sprite)
├─ js/                   All renderer logic (15 modules, IIFEs attached to window)
│   ├─ app.js            Events, command dispatch, modals, toasts
│   ├─ state.js          Single source of truth + event bus
│   ├─ grid.js           Grid rendering and virtualisation
│   ├─ masonry.js        Masonry pure functions
│   ├─ transform.js      Zoom / rotate / centre pure functions
│   ├─ lightbox.js       Lightbox
│   ├─ frame.js          Frame mode
│   ├─ loader.js         Folder scanning and drag-and-drop import
│   ├─ thumb.js          Thumbnails and on-disk cache
│   ├─ exif.js           EXIF reading
│   ├─ trash.js          Deletion and recovery
│   ├─ native.js         Platform bridge adapter
│   ├─ settings.js       Settings panel
│   ├─ a11y.js           Accessibility (announcements / focus trap)
│   └─ util.js           Helpers and file-header parsing
├─ css/                  3 stylesheets
├─ brand/                Brand assets (hand-written SVG + 7-size .ico)
├─ docs/                 README screenshots and documentation images
├─ test/                 Node pure-function unit tests
└─ deploy/
    ├─ electron/         Main-process side: main / preload / desktop / desktop-spec / exportlib
    ├─ electron-test/    Regression: run_all + 17 Electron probes + gate scripts
    ├─ release/          Release process (RELEASE.md)
    ├─ make_icons.js     SVG -> 7-size .ico (uses the project's own Electron as the renderer)
    ├─ verify_clone.js   Fresh-clone buildability gate
    └─ pack.js           Packaging
```

## Known limits

- **Windows only for now.** The tray, taskbar thumbnail buttons and jump list are Windows-native capabilities, and the icon assets are `.ico` only; a macOS build would need a `.icns`.
- **Search matches filenames only** — no EXIF / dimension / size search yet.
- **HEIC depends on a system decoder.** The app probes and reports honestly rather than bundling a decoder library, which would break the "zero dependencies" promise.
- Two accessibility items are still open: keyboard operation of multi-select state, and a throttling strategy for slideshow announcements.

## Documentation

| File | Contents |
|---|---|
| [`Atrium_开发上手手册.md`](Atrium_开发上手手册.md) | **Handbook**: commands, the five layers, landmine list, standard procedures for adding a setting or an IPC channel, frozen identifiers |
| [`Atrium_现状分析与迭代建议.md`](Atrium_现状分析与迭代建议.md) | In-depth analysis: module maturity, technical debt, roadmap |
| [`Atrium_v1.13.0_更新说明.md`](Atrium_v1.13.0_更新说明.md) | What changed in this version, and the potholes hit along the way |
| [`Atrium_问题清单与修复优先级.md`](Atrium_问题清单与修复优先级.md) | A full-project audit: issue severity, fix records and how each was verified |
| [`deploy/release/RELEASE.md`](deploy/release/RELEASE.md) | Release process: fixed order, acceptance criteria, packaging landmines |

## License

This project is licensed under the [GNU GPL v3](LICENSE).

The portable build bundles the Electron / Chromium runtime, which is covered by its own licenses
(Electron is MIT; Chromium ships its own third-party license notices). The source code in this
repository is licensed under GPL-3.0.
