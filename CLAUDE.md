# Woowil — projektnoter til Claude

Woowil er en tilpasset desktop-browser bygget på Electron, udviklet interaktivt
med brugeren (Trimlon) over mange sessioner. Denne fil er skrevet så en Claude
Code-session på en **anden maskine** hurtigt kan samle konteksten op igen.
Brugeren kommunikerer på dansk — svar på dansk medmindre andet aftales.

## Hvad appen er

En minimal, hjemmelavet browser — faneblade, lokale brugerprofiler (med
adgangskode), "arbejdsområder" (à la Vivaldi), bogmærker/historik/downloads,
lys/mørkt tema, adblock, inkognito, auto-opdatering. Ikke et wrapper-projekt
omkring en eksisterende browser — hele UI'et (toolbar, sidepanel, ny-fane-side
osv.) er skrevet fra bunden i almindeligt HTML/CSS/JS.

## Arkitektur — det vigtigste at forstå først

**`BaseWindow` + flere `WebContentsView`, ikke `BrowserWindow`/`BrowserView`.**
Dette er en bevidst, ret usædvanlig arkitekturbeslutning og forklarer flere
overraskelser i koden:

- Hvert vindue (`createWindow()` i `src/main.js`) har ét `toolbar`
  `WebContentsView` (fanebjælke, adressefelt, sidepanel — `src/renderer/`) og
  ét `WebContentsView` per åben fane. Kun toolbaren og den aktive fanes view
  er "attached" til vinduet ad gangen (`win.contentView.addChildView(...)`);
  andre faner/arbejdsområders views lever videre i baggrunden, bare ikke vist.
- **Panelet/adresseforslag/find-bar/permission-banner/update-banner er alle
  implementeret ved midlertidigt at gøre `toolbar`-viewet højere** (og
  gen-tilføje det for at rykke det øverst i z-order), i stedet for et rigtigt
  overlay-vindue. Se `layout()`, `pushExtra`/`floatExtra` i `main.js`.
- **Kendt konsekvens (fundet og rettet i v0.1.3)**: Electrons `app.quit()`
  prøver kun at lukke `BrowserWindow`-instanser først. Med `BaseWindow` er der
  intet for den at lukke, så `quit()` fuldførte aldrig efter
  `autoUpdater.quitAndInstall()` — den gamle proces blev hængende ved siden af
  den nye. Fix: eksplicit `app.exit(0)` efter en kort frist i
  `restartAndUpdate()`. **Hold øje med lignende steder** hvis noget "burde
  lukke appen" men ikke gør det — mistænk altid BaseWindow-vs-BrowserWindow
  først.

**Sikkerhedsgrænser (kontroller inden nye funktioner ændrer disse):**
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` overalt.
- `src/preload.js` (kun til toolbaren) vs. `src/pages-preload.js` (til alle
  faner, men eksponerer kun `window.woowilPages` når
  `location.protocol === 'woowil:'` — en almindelig hjemmeside ser aldrig
  IPC-broen).
- `servePage()` i `main.js` har en **allowlist** af kendte interne sider
  (`newtab`, `settings`, `history`, `bookmarks`, `downloads`) plus et
  path-resolution-tjek. Der var oprindeligt en path-traversal-sårbarhed her
  (hostname `".."` kunne læse filer uden for `pages/`) — allerede fundet og
  rettet, men **enhver ændring af `servePage`/`KNOWN_PAGES` skal bevare
  begge lag** af beskyttelsen.
- Adressefeltet blokerer `javascript:`/`vbscript:`-URL'er eksplicit
  (`UNSAFE_SCHEMES` i `main.js`) — en kendt anti-social-engineering-detalje
  fra rigtige browsere, tilføjet efter en sikkerhedsgennemgang.
- IPC-dispatch til flere vinduer går gennem `windowContexts`/`tabContextMap`
  (event.sender.id → ctx-objekt) — al ny IPC skal følge dette mønster, ikke
  registrere handlers direkte inde i `createWindow()` (det ville fejle med
  flere vinduer, da `ipcMain.on/handle` er globale).

## Filoversigt

- `src/main.js` — main-process. Alt: vinduer, faner, arbejdsområder, profiler,
  downloads, adblock, permissions, auto-updater, alle IPC-handlers.
- `src/preload.js` — `window.woowil` API til toolbaren.
- `src/pages-preload.js` — `window.woowilPages` API, kun på `woowil://`.
- `src/profile-store.js` — JSON-baseret lager under Electrons `userData`
  (`~/.config/woowil/profiles/<id>/`): settings, historik, bogmærker,
  downloads, workspace-state (navngivne arbejdsområder + hvilke faner der
  hørte til hvert, bruges til session-gendannelse).
- `src/renderer/` — selve toolbar-UI'et (faner, adressefelt, sidepanel,
  find-bar, permission-banner, update-banner, workspace-switcher).
- `src/pages/` — interne `woowil://`-sider, serveret af `servePage()`.
- `scripts/release.js` — se "Udgivelse" nedenfor.

## Udgivelse / distribution — læs dette før du bygger noget

Brug `npm run release` (kræver `GH_PUBLISH_TOKEN` + `GH_RUNTIME_TOKEN` som
miljøvariabler, se nedenfor). Det bygger Linux (AppImage) og Windows (NSIS
hvis `wine` er installeret, ellers en portabel .exe uden auto-update), og
opretter/genbruger GitHub-releasen for versionen i `package.json`.

**To tokens, med vidt forskellig magt — bland dem aldrig sammen:**
1. `GH_PUBLISH_TOKEN` — klassisk PAT, `repo`-scope. Bruges *kun* på
   byggemaskinen til at oprette releasen og uploade filer. Må aldrig ende i en
   fil, kun gives som miljøvariabel ved kørsel.
2. `GH_RUNTIME_TOKEN` — fine-grained PAT, **kun** "Contents: Read-only",
   scopet til **kun** `Trimlon/woowil-browser`. Bages ind i selve appen
   (`app-update.yml`) så den kan læse releases fra det **private** repo uden
   brugeren er logget ind. Alle der pakker appen ud kan læse denne token igen
   — det er accepteret, fordi den kun kan læse, aldrig skrive.

Ingen af tokens'ene er gemt noget sted i repoet eller i min hukommelse —
brugeren har dem, og skal give dem igen hvis en ny udgivelse skal laves.
**`GH_RUNTIME_TOKEN` har en udløbsdato på GitHub** (brugeren har tidligere
glemt at sætte "No expiration"/lang dato) — hvis auto-opdatering pludselig
holder op med at virke for alle brugere på én gang, tjek om denne er udløbet
først. Se `README.md` → "Auto-opdatering" for den fulde opsætningsguide.

**Kendt miljø-kvirk (ramt flere gange)**: lange baggrundskommandoer
(bygning + upload af 100+ MB filer tager flere minutter) bliver upålideligt
afbrudt hvis de startes via en agent-harness' eget "kør i baggrunden"-flag på
tværs af flere svar/turns. **Brug altid `nohup ... > log 2>&1 & disown`** til
den slags, og poll log-filen bagefter — det har været 100% stabilt gennem
hele udviklingen, i modsætning til andre baggrunds-mekanismer.

**Windows kræver Wine på Linux-byggemaskinen** for at lave en rigtig
NSIS-installer (`sudo apt install wine`). Uden Wine bygger
`electron-builder --win nsis` en tom/ødelagt fil (fejler med
"wine process failed ENOENT" på signering af `elevate.exe`) — scriptet falder
automatisk tilbage til en portabel .exe i så fald, som virker fint at køre,
men ikke selv kan auto-opdatere.

Windows-builden er **usigneret** (intet kodesignerings-certifikat) — nogle
Windows-opsætninger (Smart App Control på Windows 11 særligt) kan blokere den
helt lydløst, uden nogen synlig advarsel. Hvis en bruger siger "der sker
ingenting", er det første mistænkte altid dette, ikke en bug i appen.

**Linux AppImages kræver FUSE2** på visse distroer (Arch har det ikke
installeret som standard) — `sudo pacman -S fuse2`, eller kør med
`--appimage-extract-and-run` som workaround.

## Sådan blev appen testet under udvikling (ingen `xdotool`/`wmctrl` installeret)

- `python3-xlib`-scripts til klik/tastatur (`Xlib.ext.xtest.fake_input`) og
  til at rejse/fokusere/lukke vinduer ordentligt (der er focus-follows-mouse
  og andre vinduer på denne maskine, så `_NET_ACTIVE_WINDOW` alene er ikke
  nok — flyt også musemarkøren ind i vinduet).
- Skærmbilleder via `import -window <id>` (ImageMagick), ikke et
  headless-værktøj.
- **Klik-koordinater er absolutte skærm-koordinater**, ikke vindues-relative
  — læg altid vinduets `+x+y`-offset fra `xwininfo` til, ellers rammer klik
  et helt andet vindue (skete flere gange).
- Dansk tastaturlayout gør visse tegn (`:`, `/`, `_` osv.) upålidelige at
  synteticere direkte — skift midlertidigt til `setxkbmap us` når der skal
  skrives URL'er/tekst i tests, skift tilbage til `dk` bagefter.
- Denne maskines X-display-nummer skifter mellem sessioner (`:0`, `:10`,
  `:20` er alle set) — tjek `who`/`ls /tmp/.X11-unix/` hvis et vindue ikke kan
  findes, i stedet for at antage `:0`.

## Nuværende status (opdatér denne sektion når noget ændrer sig)

- Seneste version: **0.1.3** (se `package.json`).
- GitHub: privat repo `Trimlon/woowil-browser`, gren `main`.
- Kørende hos brugeren: en Windows-pc og en Arch Linux-maskine, begge sat op
  til at auto-opdatere. v0.1.3 er endnu ikke bekræftet at virke på Arch'en
  (det var netop den v0.1.2-bug der blev fundet og rettet) — spørg brugeren
  om status hvis det er relevant.
- Ingen automatiserede tests findes endnu — al verifikation har været manuel
  (se testmetode ovenfor).

## Ting brugeren bevidst har fravalgt/udskudt

- Konto-sync på tværs af enheder (kun lokale profiler).
- Chrome-udvidelser (slået fra med `disable-extensions` for lavt RAM-forbrug;
  Electron understøtter kun lokale/upakkede udvidelser med delvis API-dækning
  alligevel, ikke Web Store).
- Kodesignering af Windows-builden (koster penge, ikke gjort endnu).
