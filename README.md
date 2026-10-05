<p align="center">
  <img src="./logo.png" alt="CardMirror" width="280" />
</p>

# CardMirror — XTGG build

**This is Brian Cai's (XTGG) build of CardMirror**, a debate text editor
focused on high school and college policy debate. It's a standalone
replacement for the editor side of
**[Verbatim](https://github.com/ashtarcommunications/verbatim)**, the
Microsoft Word add-in most US debate teams use: same organizational structure,
same F-key shortcuts, same send-to-speech
workflow, same Word-compatible `.docx` files — but with no Word, no
macros, and no add-in. That keeps it fast on the multi-megabyte
evidence files debaters work in.

It's built from the original open-source CardMirror and adds its own
features and fixes on top (team files, search-to-send, document frames,
faster file opening and co-editing, signed updates, and more — see
[`CHANGELOG.md`](./CHANGELOG.md)). **Download it from this repo's
[Releases page](https://github.com/brian-cai/cardmirror/releases/latest)**
and it updates itself from here.

> **Already have CardMirror installed?** Just install this build over it
> (steps below). It replaces the app in place and keeps your settings,
> documents and send codes; from then on it updates from this repo.
>
> **Keep backups.** CardMirror is stable and used daily, but no
> editor is bug-free — keep a copy of anything critical in a second
> format.
>
> **Desktop builds aren't signed with a paid certificate**, so Windows and
> macOS warn you the first time you launch. The one-time workaround for
> each is in the install steps below.

See [`MANUAL.md`](./MANUAL.md) for the full user
manual; [`PRIVACY.md`](./PRIVACY.md) for how CardMirror handles your data;
[`TERMS.md`](./TERMS.md) for the terms of use;
[`CHANGELOG.md`](./CHANGELOG.md) for release notes;
[`ARCHITECTURE.md`](./ARCHITECTURE.md) for the full design;
[`PROJECT.md`](./PROJECT.md) for project orientation.

A video walkthrough of CardMirror's basic functions (made by the original project, so it doesn't show this build's additions) is [here](https://www.youtube.com/playlist?list=PLXM5iwKNQkSs).

## Sharing relay status

[![Sharing relay status](https://uptime.betterstack.com/status-badges/v2/monitor/2xdk0.svg)](https://cardmirror.betteruptime.com/)

Card sharing and collaboration sessions go through a small relay server.
If sharing seems broken and you're on the official relay, check its
status page at
**[cardmirror.betteruptime.com](https://cardmirror.betteruptime.com/)**
before troubleshooting on your end. (That relay and its status page are
run by the original CardMirror project, not this build. If your team uses
a private relay, ask whoever runs it.) Everything else in CardMirror works
offline and does not depend on it.

## Install

Desktop builds live on this repo's
**[Releases page](https://github.com/brian-cai/cardmirror/releases/latest)**
(the direct download links are at the top of each release). Pick the
file for your operating system, run the installer, and launch
CardMirror like any other app. Installing over an existing CardMirror
replaces it and keeps your settings.

Each release also has **CardMirror Lite** files (`CardMirror-Lite-…`),
a separate edition for school-managed devices that can't allow AI
features or internet access: no AI, no card sharing or co-editing, and no
update checks (so it doesn't update itself). It installs alongside the
regular app. Most people want the regular build.

### macOS

1. Download `CardMirror-x.x.x-universal.dmg` — one download that runs
   natively on both Apple Silicon (M1 and later) and Intel Macs.
2. Open the `.dmg`, drag **CardMirror** to your Applications folder.
3. **First launch only.** Gatekeeper refuses to open unsigned apps.
   You'll see one of two messages depending on your macOS version:

   - **"can't be opened because Apple cannot check it for malicious
     software"** → Open Finder → Applications, **right-click** (or
     Control-click) **CardMirror** → **Open**. Click **Open** in the
     confirmation dialog. From then on, normal double-click works.

   - **"is damaged and can't be opened"** → macOS has hard-quarantined
     the app and the right-click workaround doesn't suffice. Open a
     terminal (Spotlight → "Terminal") and run:
     ```sh
     sudo xattr -cr /Applications/CardMirror.app
     ```
     You'll be asked for your password. After that, normal
     double-click works.

### Windows

1. Download `CardMirror-Setup-x.x.x.exe`.
2. Run the installer (Next → Install → Finish).
3. **First launch only.** SmartScreen shows "Windows protected your
   PC." Click **More info** → **Run anyway**.

### Linux

Two options for installation, depending upon distribution:

- **AppImage** (works on every modern distro): download
  `cardmirror-x.x.x.AppImage`. In a terminal, in the download
  folder, run:
  ```sh
  chmod +x cardmirror-x.x.x.AppImage
  ./cardmirror-x.x.x.AppImage
  ```
  For most graphical desktop environments with modern file managers, you should
  be able to run the AppImage by double-clicking after the `chmod +x` command.

- **Arch and Arch-based distributions** — grab
  `cardmirror-x.x.x.pacman` from the release and:
  ```sh
  sudo pacman -U cardmirror-x.x.x.pacman
  ```
  (The `cardmirror-bin` AUR package installs the original CardMirror,
  not this build.)

### Web app (Chromebook & browser)

This build is desktop-only: there's no hosted web version of it. The
original CardMirror project runs hosted web editions at
[cardmirror.app](https://cardmirror.app/) and
[lite.cardmirror.app](https://lite.cardmirror.app/) — those are not run
by this build and don't have its features, but they work on a Chromebook
or a locked-down school machine (open in Chrome, Edge or ChromeOS and click
**Install** in the address bar).

> **Web feels slow on big documents? Check your extensions.** Some browser
> extensions — password managers (1Password, LastPass, Bitwarden) and form
> fillers especially — rescan the whole page every time you focus a text box,
> which can freeze the editor for a second or more on a large file. The desktop
> app never hits this because it loads no extensions. To confirm, open the app
> in an Incognito window (extensions are off there) — if it's snappy, an
> extension is the cause. To fix it without turning the extension off
> everywhere, tell Chrome to run it only on this site by request: click the
> **puzzle-piece (Extensions)** icon in the toolbar, click the **⋮** next to the
> extension, and set **"This can read and change site data" → "When you click
> the extension."**

### Updates

**Help → Check for Updates…** checks manually: it tells you you're
current, or announces an available update and downloads it in the
background.

CardMirror also checks for updates automatically — at launch, every
4 hours, and when you come back to the app after an hour away — speaking
up only when a new version is actually ready. The **Check for updates**
button in the status bar (bottom of the window) checks on demand.

Updates come from this repo's releases, and every one is
cryptographically signed: the app refuses to install an update whose
signature doesn't match this build's signing key (fingerprint
`THSU-D7QH-EMVL`), so a tampered download can't get onto your machine.
Turn this off (or pause it for a week — handy at a tournament) in
Settings → General → "About this install" → **Check for updates
automatically**.

Updates never interrupt you: when a new version has finished
downloading, a small chip appears in the status bar ("Update x.y.z
ready — restart to install"), and nothing installs until you click it.
On Windows and Linux, quitting the app normally also applies a
downloaded update on the way out. On macOS, clicking the chip restarts
straight into the new version; if your install can't be updated in
place (for example the app isn't in a writable folder), the chip opens
the releases page instead so you can grab the new `.dmg`.

Going to a tournament? **Pause update checks for 1 week** (Settings →
General → "About this install") stops all automatic checks and
downloads until the shown resume date.

## (Optional) Set up AI features

A few features call out to an AI model:

- AI-formatted citations from a pasted URL or freeform quote.
- AI repair of OCR / PDF extraction errors in a selection (Mod-Shift-R).
- AI image alt-text and table-from-image (right-click an image).
- AI commenting / explain features in the comments column.

Two providers are supported; pick either one:

- **Anthropic** (the default) talks directly to Anthropic's Claude
  API. Get an API key from
  [console.anthropic.com](https://console.anthropic.com/) (you'll
  need to top up a small amount of credit — Anthropic doesn't have
  a free tier for the API).
- **OpenRouter** talks to [openrouter.ai](https://openrouter.ai/),
  which fronts models from many labs behind one key — use it if you
  already have OpenRouter credit or want a specific non-Claude
  model. You choose the model by its id (e.g.
  `anthropic/claude-sonnet-4.6` or `openai/gpt-4o`) in the
  **OpenRouter model** field.

To enable them:

1. Get an API key from the provider you picked.
2. In CardMirror, click the ⚙ gear icon in the ribbon.
3. Toggle **AI features** on, choose your provider under
   **AI provider**, and paste your key into that provider's key
   field (**Anthropic API key** or **OpenRouter API key**).

The key is stored locally on your machine and is sent directly to
the provider you picked when you trigger an AI feature. It doesn't
travel through a third-party server.

**Translation** (Mod-Shift-T on a selection → copied to the clipboard)
also has an Anthropic backend, but it works **without** any AI setup: the
default MyMemory backend needs no key. You can also plug in a Google Cloud
Translation key. Configure it under Settings → Editing → Translation.

## Run from source

You only need this if you want to **build CardMirror yourself**
(contribute, run a development branch, or use the editor on a
platform we don't publish binaries for). For day-to-day use,
download a release above.

### 1. Install Node.js

CardMirror is built with JavaScript / TypeScript and needs **Node.js**
to run. Node is a regular desktop installer.

- **macOS** — open [nodejs.org](https://nodejs.org/) in your browser
  and click the blue **"LTS"** download button. Open the `.pkg`
  file from Downloads and click through the installer.
- **Windows** — open [nodejs.org](https://nodejs.org/) and click the
  blue **"LTS"** download button. Open the `.msi` file from
  Downloads and click through the installer.
- **Linux** — the easiest path is the official installer at
  [nodejs.org/en/download](https://nodejs.org/en/download/) — pick
  your distro and follow the few commands it shows.

You don't need to verify the install — if the next step works, Node
is installed.

### 2. Download the source

1. Open
   [this build's `xtgg` branch on GitHub](https://github.com/brian-cai/cardmirror/tree/xtgg)
   in your browser.
2. Click the **green `<> Code` button** near the top of the file list.
3. Click **"Download ZIP"** at the bottom of the dropdown.
4. Unzip the download. You'll get a folder called
   **`cardmirror-xtgg`**. Move it somewhere you can find later —
   your Desktop or Documents is fine.
5. **Open the `cardmirror-xtgg` folder and look inside.** Some
   unzippers double-wrap. You want the folder that directly
   contains `package.json`, `README.md`, `index.html`, and `src/`
   — if you only see another `cardmirror-xtgg` folder, that's the
   wrapper; open it.

### 3. Open a terminal inside that folder

A "terminal" is a window where you type commands. You're going to
open one already pointing at the CardMirror folder.

- **macOS** — enable Finder → right-click → *Services → New
  Terminal at Folder* once via System Settings → Keyboard →
  Keyboard Shortcuts → Services → Files and Folders, then
  right-click the folder.
- **Windows** — open File Explorer in the folder, click the address
  bar, type `cmd`, press Enter.
- **Linux** — right-click inside the folder and pick *Open Terminal
  Here* (Nautilus / Dolphin / Thunar all offer it), or open in terminal and
  `cd` to the filepath.

To make sure you're in the right directory, type `ls` (macOS / Linux)
or `dir` (Windows) and press Enter. You should see `package.json`,
`README.md`, `src`, `apps`. If you don't, your terminal is likely one
folder too high up — verify your current folder with the `pwd` command
(macOS / Linux / Windows PowerShell) or by typing `echo %cd%` (Windows, non-PowerShell).

### 4. Install dependencies

```sh
npm install
```

Downloads everything CardMirror needs. Takes 30 seconds to a couple
of minutes. Deprecation warnings are normal; only red `error` lines
indicate trouble.

### 5. Run the web edition

```sh
npm run dev
```

After a few seconds, open `http://localhost:5173/` in your browser.

### Run the desktop edition (from source)

```sh
npm run desktop:dev
```

This builds the Electron main process, starts the Vite dev server,
and launches the desktop window. Same code, same renderer — but in
a native window with file-system access.

### Coming back later

Open a terminal in the same folder; run `npm run dev` (or
`npm run desktop:dev`) again. To pick up newer code, download a
fresh ZIP and rerun `npm install` in it.

## Other commands

These all run inside the terminal pointed at the CardMirror folder
(same setup as the install steps above):

```
npm test            # run all tests
npm run test:bench  # performance benchmarks
npm run typecheck   # strict TypeScript check
```

### Testing round-trip against your own .docx files

The round-trip test suite and the round-trip benchmark both walk a
folder of `.docx` fixtures and run universal preservation checks on
each one (text length, heading IDs, mark counts, indent / spacing
multisets, etc.). Point them at any folder by setting
`CARDMIRROR_DOCS_DIR`:

```
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm test
CARDMIRROR_DOCS_DIR="/path/to/your/docx/files" npm run test:bench
```

When the variable isn't set, the suite looks under
`reference-docs/example docs/` (the project owner's local corpus).
When that folder doesn't exist either — the default state on a fresh
clone — the file-dependent tests skip cleanly and the rest of the
suite still runs.

## Round-trip a docx

The CLI imports a Verbatim/Advanced-Verbatim docx, normalizes it through
our schema, and re-exports a fresh docx:

```sh
npm run round-trip path/to/input.docx [path/to/output.docx]
```

The output is fully native to Verbatim — same canonical style ids, same
direct-formatting conventions. Stylepox and other non-Verbatim cruft is
dropped on import (per [`ARCHITECTURE.md §3`](./ARCHITECTURE.md)).

## Public API

```ts
import {
  schema,        // the ProseMirror schema
  fromDocx,      // .docx bytes → ProseMirror doc
  toDocx,        // ProseMirror doc → .docx bytes
  exportDoc,     // schema doc → { documentXml, relsXml }
  importDoc,     // document.xml → schema doc
  newHeadingId,  // generate a fresh stable heading UUID
} from 'cardmirror';
```

### Example: read a docx, modify, write it back

```ts
import { fromDocx, toDocx } from 'cardmirror';
import { readFile, writeFile } from 'node:fs/promises';

const buf = await readFile('input.docx');
const doc = await fromDocx(buf);

// `doc` is a ProseMirror Node — walk it, transform it, edit it...
console.log(`${doc.nodeSize} chars in tree`);

const out = await toDocx(doc);
await writeFile('output.docx', out);
```

### Schema highlights

```
doc:        sequence of block-level kinds
pocket:     Heading 1 paragraph (with stable id)
hat:        Heading 2 paragraph (with stable id)
block:      Heading 3 paragraph (with stable id)
card:       structured: tag (card_body | undertag | cite_paragraph | analytic | table)*
tag:        Heading 4 (only inside card)
cite_paragraph, card_body: body paragraphs inside cards
analytic:   outline-4 paragraph (Analytic style; can be standalone or in-card)
undertag:   Undertag-styled paragraph
paragraph:  unstyled body text (first-class — can sit between any nodes)
table:      table_row+ (at doc level OR inside a card / analytic_unit)
table_row:  (table_cell | table_header)+
table_cell: paragraph+
image:      inline atom (base64 bytes + EMU dimensions + alt; round-trips through .docx)
```

Every paragraph-like textblock carries round-trip-only attrs
`indent` (left indent in OOXML dxa) and `spacing` (verbatim
`<w:spacing>` map). Tables carry `rawTblPr` (table-level borders /
style / shading captured opaquely); cells carry `rawTcPr`
(per-cell borders, shading, vAlign).

Marks: `cite_mark`, `underline_mark`, `underline_direct`,
`emphasis_mark`, `undertag_mark`, `analytic_mark`, plus direct
formatting `bold`, `italic`, `strikethrough`, `superscript`,
`subscript`, `link`, `highlight`, `font_color`, `font_size`,
`shading`, `pilcrow_marker`, `font_family`, `comment_range`
(anchors a thread to a range of text).

See [`src/schema/`](./src/schema/) for full specs and
[`ARCHITECTURE.md §4`](./ARCHITECTURE.md) for design rationale.

## Plugin API (experimental)

The desktop app can load plugins — one GitHub repo per plugin,
publishing a manifest + built bundle as release assets. A plugin
registers commands that appear in the command palette, the keybindings
editor, and the printed shortcut reference like native ones, and can
extract structured card data from the current selection, jump back to
a card's source, and exchange messages with companion apps (such as a
flowing app) over the local **cardmirror-bridge** — a loopback HTTP
handshake, never the network.

Two things to know before writing one:

- **Plugins are full-trust code.** They run inside the editor with the
  same access the editor has, so installs are limited to a curated
  allowlist (served by the relay; self-hosted relay operators curate
  their own via `RELAY_PLUGIN_ALLOWLIST`). For development, use
  "Load plugin from file…" in Settings → Plugins, or unlock arbitrary
  repos with `__plugins('community-on')` in the developer console.
- **The plugin-facing API surface is a draft** (a sandboxed v2 may
  change it); the bridge handshake and HTTP routes are frozen.

The full contract — manifest fields, install flow, the capability API,
and the bridge protocol — lives in
[`reference-docs/cardmirror-plugin-api.md`](./reference-docs/cardmirror-plugin-api.md).

## Acknowledgements

CardMirror is built on [ProseMirror](https://prosemirror.net/), the
modular rich-text editor framework created and maintained by
[Marijn Haverbeke](https://marijnhaverbeke.nl/). Nearly every editor
primitive CardMirror leans on — the schema-validated transactions,
the typed-tree document model, NodeViews, plugin state, the keymap
and history modules — is ProseMirror's.

The idea to use ProseMirror, as well as credit for dozens of course-corrections along the way, belongs to [text editor wizard Slim Lim](https://slim.computer/). 

If you're curious how ProseMirror works under the hood,
[Marijn's launch post](https://marijnhaverbeke.nl/blog/prosemirror-1.html)
is the best high-level introduction, and
[the ProseMirror docs](https://prosemirror.net/docs/) cover the
APIs in depth.

Thank you to Marijn and the ProseMirror community for the years of
careful library design that made this project tractable. If
ProseMirror has been useful to you too, Marijn's work is supported
directly at <https://marijnhaverbeke.nl/fund/>.

CardMirror's voice control was shaped by ideas pioneered in the
hands-free-editing community — [Talon](https://talonvoice.com/),
[Cursorless](https://www.cursorless.org/), and
[Pokey Rule](https://github.com/pokey).

Features and code have been contributed by
[Shreeram Modi](https://github.com/shreerammodi),
[Q Cooper](https://github.com/mosuqc),
[cora](https://github.com/coralynnkc), and
[Neo Cai](https://github.com/caineoyuan). Each contribution is
credited where it shipped in the [changelog](./CHANGELOG.md).

Special thanks to Q Cooper and Missouri State debate for beta
testing.

The app's interface icons are from the
[Untitled UI free icons](https://www.untitledui.com/free-icons),
used under their free license. See
[`THIRD-PARTY-NOTICES.md`](./THIRD-PARTY-NOTICES.md) for the full
third-party attributions and license terms.

## License

Required Notice: Copyright (c) 2026 Anthony Trufanov. CardMirror (the
original project this build is based on) is licensed under the
[PolyForm Noncommercial License 1.0.0](./LICENSE). You can read,
fork, modify, and share the source for any noncommercial purpose
(personal use, hobby projects, debate-team and academic use,
research, government use, charitable / public-interest
organizations); commercial use requires a separate license. This build
is distributed under the same license. See
[`LICENSE`](./LICENSE) for the full terms.

Underlying dependencies (ProseMirror and friends) ship under their
own permissive licenses, preserved in `node_modules/`.
