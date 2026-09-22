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
- **Kendt konsekvens (fundet og rettet efter migrering til en Wayland-baseret
  udviklingsmaskine)**: under Chromiums native Wayland Ozone-backend
  registrerer et rigtigt museklik på adressefeltet (eller et hvilket som
  helst andet felt i `toolbar`-viewet) aldrig tastaturfokus i den klikkede
  `WebContentsView` — feltet ser normalt ud, men intet sker når man skriver.
  Bekræftet ved at sammenligne CDP-simuleret input (virkede altid, fordi det
  går uden om selve klik-/fokus-routingen) med rigtige `xdotool`-klik/tastatur
  (virkede kun under X11/XWayland, ikke under native Wayland). Ramte ikke den
  oprindelige X11-udviklingsmaskine, kun en ny Wayland-session — endnu et
  eksempel på at BaseWindow+flere WebContentsViews er den usædvanlige
  arkitektur, der forklarer overraskelser. `app.commandLine.appendSwitch(
  'ozone-platform', 'x11')` retter det **ikke** — child-processer (renderer/
  GPU) arver switchen fint, men selve vinduets Ozone-backend er allerede
  valgt, før main.js's JS overhovedet kører, så vinduet bliver aldrig
  oprettet synligt (ingen fejl i loggen, det forsvinder bare). Den eneste
  pålidelige fix: helt øverst i `main.js`, før `electron` overhovedet
  kræves, genstarte hele processen med `--ozone-platform=x11` som ægte argv
  (`process.argv`), ikke som en switch tilføjet fra JS. Se koden øverst i
  `main.js`.
- **Manglende default-browser-håndtering (fundet ved rigtig brug: Claude
  Code CLI's login kunne ikke åbne forbindelsen, fordi det link, som skulle
  åbnes, blev fuldstændig ignoreret)**. `woowil-install-own-browser.sh` i
  woowil-os sætter korrekt `Exec=... %U` og `MimeType=text/html;
  x-scheme-handler/http;x-scheme-handler/https;` i det installerede
  `.desktop`-ikon — OS-siden af "sæt som standardbrowser" var altid korrekt.
  Manglen var i selve appen: `main.js` havde **ingen** `app.
  requestSingleInstanceLock()`/`'second-instance'`-håndtering og læste
  aldrig en URL fra `process.argv` ved opstart — ethvert link åbnet via
  `xdg-open`/en anden app endte enten i en helt ny, overflødig
  Electron-proces (uden single-instance-lock) eller i en tom "Ny fane", med
  selve URL'en droppet på gulvet. Fixet: `requestSingleInstanceLock()` +
  `'second-instance'`-handler (finder det fokuserede vindues `ctx` via
  `windowContexts`, åbner URL'en som ny fane, fokuserer vinduet) + samme
  URL-udtræk (`extractUrlFromArgv`, matcher `^https?://`) anvendt på
  `process.argv` ved koldstart. Verificeret med rigtige
  `electron . <url>`-kald: både koldstart-med-URL og
  allerede-kørende-instans+ny-URL åbner nu korrekt en ny fane i stedet for
  at tabe linket. **Ethvert nyt sted, der kan modtage et link udefra (nyt
  OS-integration, protokol-handler osv.), skal gå gennem `ctx.
  openExternalUrl`, ikke oprette et helt nyt vindue/instans.**
- **Kendt konsekvens af X11-tvangen (`getContentBounds()` er upålidelig)**:
  ved maksimering via vindueshåndteringen (ikke ved at trække et hjørne)
  under den tvungne X11-ozone-backend forblev `win.getContentBounds()` et
  stykke tid med den GAMLE, lille størrelse, selvom `win.isMaximized()` og
  `win.getBounds()` allerede var opdateret — resultatet var et stort sort
  område, fordi `toolbar`/fane-viewsne blev sat til den forkerte størrelse.
  `layout()` bruger nu `win.getBounds()` i stedet (vinduet har ingen egen
  OS-ramme/titellinje, så indhold = ydre størrelse her). Lyt også efter
  `'maximize'`/`'unmaximize'`, ikke kun `'resize'` — de fyrer uafhængigt.
- **`sendWorkspaces()` må ALDRIG også persistere** — den bruges både til
  rene forespørgsler (toolbarens `getWorkspaces()`-kald ved opstart, FØR
  `loadWorkspacesAndOpenTabs` har læst den rigtige gemte tilstand fra disk)
  og til at fortælle renderer'en om en reel ændring. Da den tidligere også
  kaldte `persistWorkspaceState()`, overskrev den allerførste forespørgsel
  hver eneste opstart den rigtige session med tomme standardværdier — det
  så ud som om browseren var "ren hver gang", uanset `restoreSession`.
  Fjern aldrig igen persistering herfra; kald `persistWorkspaceState()`
  eksplicit i de funktioner, der faktisk ændrer noget.
- **`woowil:navigate`-kanalen bruges af BÅDE `preload.js` (toolbarens
  adressefelt) OG `pages-preload.js` (alle interne `woowil://`-siders egne
  søge-/adressefelter, fx ny-fane-sidens)** — men handleren matchede kun
  `ctxFor` (kun toolbar-webContents), ikke `tabCtxFor` (fane-webContents).
  Ny-fane-sidens søgefelt gjorde derfor ingenting ved indsendelse. Handleren
  skal altid tjekke begge: `ctxFor(event) ?? tabCtxFor(event)`.

**Sikkerhedsgrænser (kontroller inden nye funktioner ændrer disse):**
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` overalt.
- `src/preload.js` (kun til toolbaren) vs. `src/pages-preload.js` (til alle
  faner, men eksponerer kun `window.woowilPages` når
  `location.protocol === 'woowil:'` — en almindelig hjemmeside ser aldrig
  IPC-broen).
- `servePage()` i `main.js` har en **allowlist** af kendte interne sider
  (`newtab`, `settings`, `history`, `bookmarks`, `downloads`, `extensions`)
  plus et path-resolution-tjek. Der var oprindeligt en
  path-traversal-sårbarhed her (hostname `".."` kunne læse filer uden for
  `pages/`) — allerede fundet og rettet, men **enhver ændring af
  `servePage`/`KNOWN_PAGES` skal bevare begge lag** af beskyttelsen.
- **En installeret Chrome-udvidelse er en langt større tillidsgrænse end
  en almindelig hjemmeside** — den kan læse/ændre indhold på tværs af alle
  sider den har `matches`-adgang til, uafhængigt af denne apps egne
  `contextIsolation`/`sandbox`-grænser (det er sådan extension-API'et er
  designet til at virke, ikke en fejl her). Der er bevidst ingen
  signatur-/kilde-verificering af installerede `.crx`/.zip-filer eller
  mapper — brugeren installerer udelukkende noget de selv aktivt har
  valgt en fil til, samme tillidsmodel som når man selv slår
  "udviklertilstand" til i rigtige Chrome.
- Adressefeltet blokerer `javascript:`/`vbscript:`-URL'er eksplicit
  (`UNSAFE_SCHEMES` i `main.js`) — en kendt anti-social-engineering-detalje
  fra rigtige browsere, tilføjet efter en sikkerhedsgennemgang.
- IPC-dispatch til flere vinduer går gennem `windowContexts`/`tabContextMap`
  (event.sender.id → ctx-objekt) — al ny IPC skal følge dette mønster, ikke
  registrere handlers direkte inde i `createWindow()` (det ville fejle med
  flere vinduer, da `ipcMain.on/handle` er globale).

## Chrome-udvidelser

Per-profil (samme model som Chrome selv, og matcher projektets eksisterende
per-profil session-partitions) — ikke ét globalt sæt delt af alle profiler.
Ingen adgang til selve Chrome Web Store (Electron har ikke det); brugeren
installerer fra en udpakket mappe eller en .crx-/.zip-fil via
`woowil://extensions`.

- **`session.loadExtension()`/`.removeExtension()`/`session.on('extension-
  loaded', ...)` er forældede i denne Electron-version — brug
  `session.fromPartition(partition).extensions.*` i stedet.** Bekræftet
  direkte (ikke kun ud fra en deprecation-advarsel) med et minimalt
  standalone script før noget af dette blev kodet ind i `main.js`: den
  gamle vej virker stadig, men logger en advarsel; hele API-fladen
  (`loadExtension`, `removeExtension`, `getAllExtensions`, begge events)
  findes identisk under `.extensions`.
- **En session skal have `persist:`-præfiks for overhovedet at kunne
  indlæse udvidelser** — et bart `session.fromPartition(id)` (uden
  `persist:`) fejler med "Extensions cannot be loaded in a temporary
  session", bekræftet direkte. Incognito-vinduers partition har bevidst
  intet `persist:`-præfiks (se `incognitoPartition` i `main.js`) — matcher
  heldigvis også hvordan rigtige browsere som udgangspunkt opfører sig
  (udvidelser kører ikke i incognito), så `ensureExtensionsHandled()`
  springer indlæsning helt over for den slags partitions, og
  installations-funktionerne afviser eksplicit med en fejlbesked frem for
  at ramme denne exception blindt.
- **Egen `storageId` (en UUID vi selv genererer), ikke Chromes egen
  `extension.id`, er nøglen i `extensions.json` og for selve mappenavnet
  under `extensionsDir()`.** Chromes id afhænger af enten en `key` i
  manifestet eller — når den mangler, som for stort set alt der ikke er
  hentet fra selve Web Store — en hash af den absolutte installationssti.
  At forsøge at omdøbe en allerede indlæst udvidelses mappe til at matche
  dens egen afledte id bagefter virker ikke pålideligt (den indlæste
  instans peger stadig på den gamle sti internt i Chromium). Løsningen: stien
  vi installerer til rører vi aldrig igen — `extensionMetadata()` i
  `main.js` udleder `storageId` tilbage fra `extension.path`s eget
  mappenavn hver gang, så der aldrig er tvivl om hvilken installeret post
  et indlæst `extension.id` hører til.
- **Ægte, reproducerbar hænge-fejl fundet og rettet under test**: at lukke
  extension-popup'en (`closeExtensionPopup()`) ved at fjerne dens
  `WebContentsView` og bagefter nulstille state kunne re-entre sig selv —
  `removeChildView()` udløser popup'ens eget `'blur'`-event synkront som
  en sideeffekt, og den blur-handler kalder `closeExtensionPopup()` igen,
  som (fordi state endnu ikke var nulstillet) forsøgte at lukke den samme
  `webContents` en gang til og frøs hele appen (bekræftet live — selv CDP
  stoppede med at svare). Rettelsen: nulstil `extensionPopupView`/
  `extensionPopupOwnerId` til `null` **før** `removeChildView()`/
  `webContents.close()` kaldes, ikke bagefter — samme
  nulstil-state-før-du-river-ned-mønster er værd at huske hvis flere
  synkrone "luk denne overlay"-funktioner tilføjes senere.
- **Popup'en er sin egen `WebContentsView`, ikke HTML inde i toolbarens
  egen side** — i modsætning til adresseforslag/workspace-switcher (som
  bruger `setOverlayOpen()` til bare at gøre toolbar-viewet højere, fordi
  det indhold allerede ligger i toolbarens eget dokument). En udvidelses
  popup skal køre med sin egen `chrome-extension://<id>/`-origin for
  overhovedet at få `chrome.*`-API'erne, så den kan ikke bare indlejres som
  et iframe i en anden sides DOM. `extensionAction()` opretter/positionerer
  derfor en helt ny `WebContentsView` under den klikkede knap (koordinater
  sendt fra `toolbar.js` via `getBoundingClientRect()`), på samme måde som
  faner selv oprettes og fjernes.
- **Værktøjslinjens ikon-knapper er bygget fra bunden i `toolbar.js`** (der
  er jo ingen indbygget Chrome-værktøjslinje her) — selve ikonet sendes som
  en `data:`-URL fra main-processen (læst og base64-encodet direkte fra
  udvidelsens egen manifest-refererede fil), så renderer-processen aldrig
  selv behøver at kunne hente `chrome-extension://`-indhold.
- **Testet grundigt live** med en minimal selvlavet MV3-testudvidelse
  (indlæsning, ikon i værktøjslinjen, klik åbner/lukker popup, aktiver/
  deaktiver, fjern, persistering på disk) og en standalone-test af selve
  CRX/ZIP-udpakningen (inkl. en simuleret CRX med falske header-bytes foran
  den rigtige ZIP). **Ikke** testet: den native filvælger-dialog
  (`dialog.showOpenDialog`) selv — samme klasse miljøbegrænsning som ramte
  VM-testing i woowil-os-projektet (portal-baserede dialoger ser ikke ud
  til at kunne åbne rigtigt i dette sandboxede/remote skrivebordsmiljø);
  test dette specifikt på en rigtig maskine før det regnes for 100%
  bekræftet end-to-end.

## Filoversigt

- `src/main.js` — main-process. Alt: vinduer, faner, arbejdsområder, profiler,
  downloads, adblock, permissions, auto-updater, extensions, alle
  IPC-handlers.
- `src/preload.js` — `window.woowil` API til toolbaren.
- `src/pages-preload.js` — `window.woowilPages` API, kun på `woowil://`.
- `src/profile-store.js` — JSON-baseret lager under Electrons `userData`
  (`~/.config/woowil/profiles/<id>/`): settings, historik, bogmærker,
  downloads, workspace-state (navngivne arbejdsområder + hvilke faner der
  hørte til hvert, bruges til session-gendannelse), installerede
  udvidelser (`extensions.json` + selve de udpakkede mapper under
  `extensions/<storageId>/`).
- `src/renderer/` — selve toolbar-UI'et (faner, adressefelt, sidepanel,
  find-bar, permission-banner, update-banner, workspace-switcher,
  extension-knapper).
- `src/pages/` — interne `woowil://`-sider, serveret af `servePage()`,
  inkl. `extensions/` (installer/liste/fjern udvidelser).
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

- Seneste version: se `package.json` (bumpes ved hver release).
- GitHub: privat repo `Trimlon/woowil-browser`, gren `main`.
- Kørende hos brugeren: primært en rigtig Woowil OS-installation nu (efter
  at have skiftet fra almindelig Arch). Udvikling/test i denne session er
  foregået på en delt, fjernstyret cloud-udviklingsmaskine (KDE + krdp) —
  **ikke** brugerens rigtige maskine. Vigtig lære fra det: den maskines
  fjernskrivebordsforbindelse har sin egen, ægte fejl i AltGr-tastatur-
  tilstand (Chromium glemmer at AltGr stadig er holdt nede mellem
  keydown-events — bekræftet med rå input-logning: `alt: true` på selve
  AltGr-tasten, men `alt: false` på den efterfølgende taste, der skulle
  være AltGr-skiftet). Det gav "@" (og formentlig andre AltGr-tegn) som
  bare den ukombinerede tast i stedet. **Bekræftet IKKE at ske på brugerens
  egen, rigtige Woowil OS-maskine** — det er et miljø-specifikt kvirk ved
  denne ene udviklingsmaskines input-videresendelse, ikke en Woowil
  Browser-bug. Antag ikke det samme gælder næste gang; test på rigtig
  hardware hvis muligt, og mistænk denne artefakt før noget andet hvis
  AltGr-tegn opfører sig mystisk her.
- Ingen automatiserede tests findes endnu — al verifikation har været manuel
  (se testmetode ovenfor).

## Ting brugeren bevidst har fravalgt/udskudt

- Konto-sync på tværs af enheder (kun lokale profiler).
- Kodesignering af Windows-builden (koster penge, ikke gjort endnu).
