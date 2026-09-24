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
  den rigtige ZIP).
- **`dialog.showOpenDialog()` skal have et vindue som første argument, eller
  crasher appen på rigtig hardware** — fundet efter v0.2.0 var udgivet: den
  native filvælger-dialog kunne slet ikke testes i dette projekts eget
  sandboxede/remote skrivebordsmiljø (samme miljøbegrænsning som ramte
  VM-testing i woowil-os — portal-baserede dialoger ser ikke ud til at
  kunne åbne rigtigt der; kaldet hang bare, uden fejl), så det blev udgivet
  utestet. Brugeren rapporterede et rigtigt crash på egen maskine.
  `src/main.js` havde allerede et velfungerende eksempel at sammenligne
  med (`dialog.showSaveDialog(win, {...})`, brugt til "udskriv til PDF")
  — det ENESTE der manglede i de to nye `dialog.showOpenDialog(...)`-kald
  var selve `win`-argumentet, som i denne apps helt igennem
  `BaseWindow`-baserede arkitektur er langt fra "optional" i praksis, uanset
  hvad Electrons egen dokumentation antyder. **Enhver ny `dialog.*`-brug
  skal altid have `ctx.win` (eller det tilsvarende vindue) som første
  argument** — spring det aldrig over, selv når det ser ud til at virke i
  test.
- **`dialog.showOpenDialog()` kan stadig SIGSEGV'e, selv med korrekt
  `ctx.win`, hvis den native dialog routes gennem xdg-desktop-portal** —
  fundet efter v0.2.1 (som fixede ovenstående `ctx.win`-bug) stadig
  crashede på brugerens rigtige KDE-maskine "kort efter" udvidelsessiden.
  Denne gang lykkedes det faktisk at reproducere crashet på en delt
  udviklingsmaskine (i modsætning til den rene sandbox, hvor portal-dialoger
  bare hænger uden fejl): `coredumpctl` viste et rigtigt SIGSEGV i
  hovedtråden inde i en GLib main-context-iteration, umiddelbart efter
  loggen registrerede portalens `application/vnd.portal.filetransfer`/
  `application/vnd.portal.files`-atomer — dvs. under selve
  xdg-desktop-portal FileChooser D-Bus-handshaket, ikke i vores egen JS.
  Kunne ikke gentvinge crashet 100% deterministisk via CDP-simulerede klik
  (samme begrænsning som før — ægte portal-interaktion kræver en rigtig
  bruger), så fixet er baseret på stack-trace-beviset, ikke en direkte
  "crashede før, crasher ikke nu"-verifikation. Fix: `process.env.
  GTK_USE_PORTAL = '0'` sat allerført i `main.js`, før noget GTK-relateret
  initialiseres (også før den eksisterende X11-genstart-logik, så flaget
  arver med over i den respawnede proces) — tvinger GTK til sin klassiske
  in-process filvælger i stedet for portal-D-Bus-vejen. Udgivet som v0.2.2;
  bed altid brugeren bekræfte på rigtig hardware efter denne slags fix, da
  sandboxen ikke selv kan give en fuld positiv verifikation.
- **RETTELSE til ovenstående: v0.2.2 løste IKKE brugerens crash** —
  brugeren rapporterede stadig crash, og det viste sig at være noget helt
  andet: ikke vores `woowil://extensions`-side eller nogen `dialog.*`-kald
  overhovedet, men selve **chromewebstore.google.com**-webstedet (hvor
  brugeren prøvede at hente Bitwarden/Claude-udvidelser). Denne gang blev
  det gentvunget 100% deterministisk (to gange, samme absolutte
  krasch-adresse begge gange) ved at starte appen under `gdb` med
  `catch signal SIGSEGV` og bare navigere til en `/detail/<id>`-side på
  Chrome Web Store — ingen klik krævedes overhovedet. Disassemblen viste et
  reelt null-pointer-kald (`mov 0x0,%rcx` efterfulgt af `call *0x40(%rcx)`,
  dvs. et virtuelt kald gennem et null-objekt) i browser-processens
  hovedtråd. En websøgning fandt den præcise, allerede kendte årsag: dette
  er en ægte fejl i **Electron 44.3.0 selv** (ikke i vores kode) —
  Chromium eksponerer `chrome.webstorePrivate` til almindelige websider på
  Chrome Web Store uden nogen `WebstorePrivateAPIDelegate` bagved i
  Electron, og butikkens egen side kalder
  `chrome.webstorePrivate.getReferrerChain()` med det samme en
  produktside renderes — det null-delegate-kald er præcis det der
  segfaulter hele browser-processen (og dermed alle vinduer/faner på
  samme tid). Rettet opstrøms i Electron 44.4.0 (udgivet 2026-09-15):
  `chrome.webstorePrivate` er nu helt utilgængelig, og de core-registrerede
  funktioner svarer med en fejl i stedet for at kalde ind i en null
  delegate. **Fix: opgraderet `electron`-devDependency fra `^44.0.0`
  (reelt installeret: 44.3.0) til `^44.4.3`.** Verificeret ved at gentage
  præcis den samme gdb+navigations-reproduktion efter opgraderingen — ingen
  crash, siden loader fint (butikkens egen JS kaster nu bare en harmløs
  "Uncaught (in promise) Error" i stedet for at tage hele appen ned).
  Udgivet som v0.2.3. **Lære for fremtiden**: når et rapporteret crash ikke
  forsvinder efter et målrettet fix, så tro ikke automatisk at den første
  hypotese var forkert i detaljen — overvej om det er en helt anden,
  endnu ikke identificeret fejl, og brug `gdb`+`catch signal` til en
  virkelig deterministisk reproduktion frem for at gætte videre på
  stack-traces fra `coredumpctl` alene. En hurtig websøgning på den
  konkrete krasch-signatur (nulpointer + Electron-version + hvilken
  hjemmeside) sparede meget tid her.
- GTK_USE_PORTAL=0-fixet fra forrige punkt er stadig i koden og skader
  ikke noget, men det var altså aldrig den egentlige årsag til brugerens
  gentagne crash-rapporter — hold det adskilt i hovedet fra
  webstorePrivate-fejlen ovenfor, hvis der nogensinde dukker endnu et
  `dialog.*`-relateret crash op.
- **Chrome Web Stores egen "Tilføj til Chrome"-knap kan aldrig komme til at
  virke i denne app, crash eller ej** — selv efter v0.2.3-fixet ovenfor
  (som kun forhindrer at et stray `chrome.webstorePrivate`-kald crasher
  browser-processen) er `chrome.webstorePrivate` stadig fuldstændig
  ikke-implementeret i Electron: siden kalder nu bare ind i en stub der
  svarer med en fejl i stedet for at installere noget. Det er en bevidst
  Electron-arkitekturbeslutning, ikke noget der kan rettes fra appens side.
  Løsning: `installExtensionFromWebStore(input)` i `main.js` — brugeren
  indsætter et Chrome Web Store-link (eller bare id'et) i et nyt felt på
  `woowil://extensions`, og vi henter selve `.crx`-filen direkte fra
  Googles offentlige opdaterings-endpoint
  (`clients2.google.com/service/update2/crx?...`) — samme endpoint en
  rigtig installeret Chrome selv bruger til at opdatere udvidelser, ikke
  scraping eller en privat API. Verificeret direkte mod den rigtige
  Bitwarden-udvidelse (23 MB, gyldig CRX3, udpakkes korrekt gennem den
  eksisterende `extractExtensionArchive()`). Genbruger
  `installExtensionFromArchive()` internt (skriver de hentede bytes til en
  midlertidig fil i `os.tmpdir()`, kalder den eksisterende
  fil-installations-vej, rydder den midlertidige fil op bagefter) —ingen
  duplikeret install-/valideringslogik.
- **`resolveManifestName()`** (ny hjælpefunktion, bruges alle steder et
  udvidelsesnavn vises) — nogle udvidelser (Bitwarden inklusiv) sætter
  `manifest.json`'s `name`-felt til en bogstavelig `__MSG_xxx__`-placeholder
  og forventer at en rigtig Chrome slår den op i
  `_locales/<default_locale>/messages.json`. Uden dette ville sådan en
  udvidelse vise `__MSG_extName__` som sit navn i UI'en i stedet for
  "Bitwarden Password Manager" — fundet ved at teste den rigtige
  Bitwarden-crx, ikke noget der var synligt med den tidligere
  minimale MV2-testudvidelse.
- Udgivet som v0.2.4.
- **`electron-chrome-extensions` integreret — rigtige udvidelser (Bitwarden
  m.fl.) virker nu, inklusiv popup'er, efter appen selv gik open source
  under GPL-3.0** (se README → "Licens"): den tidligere licenskonflikt er
  væk (begge er nu GPL-3.0-kompatible), og det viste sig — modsat hvad en
  ældre version af bibliotekets README antydede — at biblioteket (v4.9.0)
  reelt tager `Electron.BaseWindow` overalt i sin type-signatur
  (`addTab(tab: WebContents, window: BaseWindow)`,
  `PopupView`'s `parent: BaseWindow`), ikke `BrowserWindow` — bekræftet
  direkte i den installerede pakkes egne `.d.ts`-filer, ikke i README'en,
  så tjek altid selve typerne ved en fremtidig opdatering af biblioteket
  frem for at stole på dokumentationens ordlyd. Verificeret med en
  minimal standalone `BaseWindow`+`WebContentsView`-testapp (samme
  arkitekturmønster som denne app) FØR noget blev rørt i `main.js` —
  samme disciplin som resten af dette projekt.
  - **Hvad der ændrede sig**: `ensureExtensionsHandled()` opretter nu også
    én `ElectronChromeExtensions`-instans pr. partition (i
    `chromeExtensionsApiByPartition`), med `createTab`/`selectTab`/
    `removeTab`-callbacks der finder det rigtige vindue via den nye
    `findWindowContextForPartition()` (flere vinduer kan dele samme
    profils partition — vælger det fokuserede, ellers det første).
    `createTab()`/`switchToTab()`/`closeTab()` kalder nu selv
    `chromeExtensionsApi.addTab()`/`.selectTab()`/`.removeTab()` den anden
    vej, så biblioteket altid ved hvilke faner der findes. Hele det gamle
    håndbyggede popup-lag (`extensionPopupView`, `closeExtensionPopup()`,
    `extensionAction()`, `sendExtensions()`, `woowil:extension-action`-IPC,
    `#extensions-bar`/`.extension-btn` i toolbar.js/html/css) er fjernet —
    erstattet af `<browser-action-list>`-elementet
    (`electron-chrome-extensions/browser-action`), som selv tegner ikoner
    (via `crx://`-protokollen) og styrer popup'en (som en helt separat,
    rigtig `BrowserWindow`, ikke en `WebContentsView` som før).
  - **Vores eget installations-/administrationslag (`installExtension*`,
    `woowil://extensions`-siden, `profile-store.js`'s `extensions.json`,
    `loadedExtensionsByPartition`/`ensureExtensionsHandled`'s
    `extension-loaded`/`-unloaded`-lyttere) er UÆNDRET** — biblioteket
    erstatter kun "hvilke chrome.*-API'er virker for allerede-indlæste
    udvidelser + værktøjslinje-ikon/popup-UI'et", ikke hvordan udvidelser
    installeres/fjernes/gemmes.
  - **`crx://`-protokollen skal håndteres på toolbar'ens EGEN session
    (default session), ikke på hver profils partition-session** — fundet
    ved at læse selve bibliotekets kompilerede kildekode (ikke kun
    typedefinitionerne): `handleCRXProtocol(session)` registrerer sig på
    den session der MODTAGER forespørgslen (her: toolbar'en, som altid
    kører på `session.defaultSession`, se kommentaren ved
    `protocol.handle('woowil', ...)`), og slår selv den RIGTIGE
    målpartition op via et `?partition=`-query-param på selve
    `crx://`-URL'en. At kalde den på profil-sessionen (min første,
    forkerte antagelse, baseret på min egen standalone-test hvor
    værktøjslinjen ved en fejl delte session med fanerne) gjorde intet.
  - **Reel opstarts-race fundet og fikset ved rigtig test, ikke gættet
    frem**: `<browser-action-list>` forsøger at forespørge "aktiv fane"-
    tilstand med det samme den monteres i DOM'en — men `ensureExtensions
    Handled()` (og dermed selve `ElectronChromeExtensions`-instansen, som
    globalt kun første gang registrerer IPC-kanalen `crx-msg-remote` for
    HELE appen via bibliotekets interne `RoutingDelegate`-singleton) blev
    tidligere først kaldt dovent inde i `createTab()`, som kører EFTER
    værktøjslinjens side allerede er loadet og har nået at forsøge sit
    første kald. Symptom set live: konsol-fejl "No handler registered for
    'crx-msg-remote'" og en permanent tom værktøjslinje (ingen ikoner
    overhovedet), fordi elementet ikke selv prøver igen efter et
    mislykket første forsøg. Fix: `ensureExtensionsHandled()` for det
    aktive vindues partition kaldes nu tidligt i `createWindow()`, FØR
    `toolbar.webContents.loadFile(...)`.
  - **Sandboxede preloads kan ikke `require()` npm-pakker direkte** —
    `electron-chrome-extensions/browser-action`'s `injectBrowserAction()`
    skal ind i værktøjslinjens preload, men den er (med god grund)
    `sandbox: true`; et almindeligt `require()` af pakken fejlede live med
    "module not found" selv om den samme `require()` virker fint
    u-sandboxed. Løsning: `scripts/bundle-preloads.js` (esbuild, kaldt fra
    `prestart` og fra `release.js` før hvert build) bundler
    `src/toolbar-preload-entry.js` (som blot `require()`'r både det
    gamle `preload.js` og `injectBrowserAction()`) til én selvstændig
    `src/toolbar-preload.bundle.js` (git-ignoreret, altid regenereret) —
    `main.js`'s toolbar-`WebContentsView` peger på den bundlede fil, ikke
    på `preload.js` direkte længere.
  - **`alignment="bottom right"`** sat eksplicit på `<browser-action-list>`
    i `toolbar.html` — biblioteket kalder det "bottom left" som sin egen
    standard, hvilket i denne apps layout (værktøjslinjen sidder øverst)
    placerede popup'en delvist UDENFOR skærmen foroven ved et første,
    forkert `alignment="top right"`-forsøg (fanget live: `xdotool
    getwindowgeometry` viste `y: -10`) — "bottom" betyder popup'en åbner
    NED under knappen, "right" at dens højre kant flugter med knappens,
    samme visuelle mønster som en rigtig Chrome.
  - Testet grundigt live, ende-til-ende, mod den ægte Bitwarden-udvidelse
    (ikke kun en minimal testudvidelse): installation via
    `installExtensionFromWebStore`, ikon vises korrekt i værktøjslinjen,
    klik åbner en rigtig popup der når helt frem til Bitwardens egen
    onboarding-UI (`#/intro-carousel`, ikke længere fanget på en evig
    indlæsnings-spinner), samt en regressionstest af almindelig
    fane-oprettelse/navigation/inkognito-vinduer efter ændringerne.
  - **Kendt, ikke-blokerende støj**: Bitwardens baggrunds-service-worker
    (formentlig dens `alarms`-brug) udløser periodisk (hvert ~10. sekund)
    `NOTREACHED hit. Unexpected view type found: 0` i Electrons/Chromiums
    egen extensions-kode — logges, men crasher ikke og påvirker ikke
    synligt funktionaliteten; ikke undersøgt yderligere, da det ikke
    blokerer den faktiske brug.
  - Udgivet som v0.2.6.

## Password manager (gemme/udfylde brugernavne+adgangskoder, eksport)

Endnu ikke udgivet i noget versionsnummer — bygget hen over flere sessioner,
denne beskrivelse dækker det samlede resultat.

- **Kryptering via `safeStorage` (OS'ets egen nøglering: libsecret/DPAPI/
  Keychain), ikke selvskrevet kryptografi.** `encryptPassword`/
  `decryptPassword` i `main.js` er tynde wrappere om
  `safeStorage.encryptString`/`.decryptString`. Hvis
  `safeStorage.isEncryptionAvailable()` er `false` (ingen understøttet
  nøglering overhovedet), nægter appen bevidst at gemme i klartekst —
  kaster i stedet en klar fejl, samme "fail loudly" -princip som
  woowil-mails egen keyring-fallback.
- **`credentials.json`/`never-save-origins.json` er nye per-profil-filer i
  `profile-store.js`**, samme mønster som eksisterende bogmærker/historik/
  udvidelser (`upsertCredential` matcher på origin+brugernavn og
  opdaterer in-place, `findCredentialsForOrigin`, `addNeverSaveOrigin` osv.).
- **Login-formular-detektion og autofill sker i `pages-preload.js`, uden
  at eksponere NOGET kaldbart til selve siden** — `contextIsolation`
  isolerer kun JS-objekter/globals mellem side og preload, ikke selve
  DOM-træet, så preload-scriptet kan læse/skrive formularfelter direkte på
  en hvilken som helst side uden en `contextBridge`-bro en ondsindet side
  kunne misbruge. Formular-submit fanges i capture-fasen (ser stadig
  submittet selvom sidens egen JS kalder `preventDefault()` og selv
  håndterer login via `fetch`/XHR, meget almindeligt på moderne
  login-sider), og autofill sker ved `DOMContentLoaded` via et
  `ipcRenderer.invoke('woowil:get-autofill', location.origin)`-kald.
- **Gem-adgangskode-bjælken i toolbaren følger nøjagtig samme mønster som
  `permission-bar`/`update-bar`** — `main.js` sporer selv
  `passwordBannerOpen`/`PASSWORD_BAR_HEIGHT` (40px, samme højde som de to
  andre) og kalder `updateExtras()` til at ændre selve
  `WebContentsView`'ens højde; `toolbar.js`/`.html`/`.css` viser/skjuler
  bare `#password-bar` baseret på `password-prompt`-IPC-eventet, ingen
  egen højde-logik nødvendig i renderer'en. Tre knapper: "Gem" (krypterer
  og gemmer), "Aldrig for denne side" (`addNeverSaveOrigin`, ingen
  kryptering involveret), "×" (Ikke nu — luk bjælken, spørg igen næste
  gang). Panelet har et nyt "🔑 Adgangskoder"-link (samme
  `data-nav`-mønster som de andre interne sider, ingen ekstra JS
  nødvendig).
- **`woowil://passwords`-siden viser ALDRIG en adgangskode i klartekst som
  standard** — `getPasswordsPage()` returnerer kun id/origin/brugernavn/
  opdateringstidspunkt; kun et eksplicit "Vis"-klik pr. række kalder
  `revealPasswordPage(id)`, som dekrypterer netop den ene adgangskode. Har
  søgefelt, "Skjul" til at maskere igen, og "Fjern" (med `confirm()`).
  "Eksportér…"-knappen viser en `dialog.showMessageBox`-advarsel FØR selve
  gem-dialogen (samme to-trins-advarsel som Chrome/Firefox selv viser før
  en adgangskode-eksport), skriver Chromes eget CSV-format
  (`name,url,username,password`) for interoperabilitet med andre
  password-managere.
- **Bogmærke-eksport bruger Netscape Bookmark File Format**
  (`<!DOCTYPE NETSCAPE-Bookmark-file-1>`) — det universelle
  import/eksport-format alle browsere allerede forstår, i stedet for et
  Woowil-specifikt JSON-dump ingen andre kan læse. `exportBookmarksPage()`
  i `main.js` var allerede færdig fra en tidligere session; det eneste der
  manglede var selve "Eksportér bogmærker…"-knappen på
  `woowil://bookmarks`-siden (nu tilføjet, samme fejlvisnings-mønster som
  adgangskode-sidens eksportknap - `result.error` vises, `result.canceled`
  ignoreres stille).

### VIGTIGT: `safeStorage` kan fryse HELE hovedprocessen i dette
sandboxede udviklingsmiljø — testet, ikke gættet

Fundet ved rigtig, live test af "Gem"-knappen: at klikke den hængte
appen fuldstændig (alle vinduer/faner, selve CDP-debug-forbindelsen
holdt op med at svare) i titusindvis af millisekunder, gentagne gange.
Roden er ikke en fejl i denne apps kode: `dbus/object_proxy.cc`-logs viste
`org.kde.KWallet.open`/`.isEnabled`-kald der løb ud efter det klassiske
D-Bus-timeout (~25 sekunder) med `DBus.Error.NoReply`, efterfulgt (på et
senere forsøg) af et forsøg på at (gen)starte `kwalletd6` via den gamle
`org.kde.KLauncher`-tjeneste, som fejlede med det samme
(`ServiceUnknown: The name is not activatable`) — denne fjernstyrede
udviklingsmaskines KDE-session er tydeligvis delvis/ufuldstændig (ingen
rigtig `klauncher` kørende), ikke en fejl i selve Woowil Browser.

**Hvorfor dette er værre end woowil-mails tilsvarende keyring-fund**:
Electrons `safeStorage.encryptString()`/`.decryptString()` er 100%
synkrone og blokerer bogstaveligt hele Electron-hovedprocessens
event-loop, ikke bare én HTTP-request-handler-tråd som i Python/FastAPI.
Der findes ingen async-variant af `safeStorage` at skifte til. Denne app
kan derfor ikke selv forhindre en lignende fastfrysning på en rigtig
brugers maskine, hvis DENNE brugers nøglering-daemon også skulle være
langsom/utilgængelig et splitsekund - det er en grundlæggende
Electron/OS-begrænsning, ikke noget der kan patches herfra.

**Hvad der BLEV testet med succes i dette miljø** (alt hvad der ikke
rører `safeStorage` direkte): formular-submit udløser bjælken med korrekt
tekst, "Ikke nu" og "Aldrig for denne side" virker begge korrekt (ingen af
dem kalder kryptering), et "aldrig gem"-origin viser aldrig bjælken igen
ved efterfølgende submits, panel-linket navigerer korrekt til
`woowil://passwords`, siden viser sin tomme-tilstand og eksportknappen
findes, en bogmærke blev oprettet og vist korrekt på `woowil://bookmarks`
med den nye eksportknap, og at klikke "Eksportér bogmærker…" åbnede den
native gem-dialog uden at fryse processen (samme allerede-dokumenterede
begrænsning som andre native dialoger i dette repo - selve
dialog-interaktionen kan ikke automatiseres i sandboxen, men selve kaldet
virker).

**Hvad der IKKE kunne verificeres her**: at rent faktisk gemme en
adgangskode (klik "Gem"), at genindlæse en side og se autofill ske, og at
"Vis"-knappen på `woowil://passwords` rent faktisk dekrypterer noget - alt
sammen fordi det kræver et rigtigt `safeStorage`-kald, som hænger i dette
miljø. **Bed brugeren bekræfte disse tre specifikke ting på deres egen
rigtige Woowil OS-maskine** (som har en normal, fuldt fungerende
KDE/KWallet-session) før dette regnes for færdigt testet - samme
"kan ikke verificeres i sandbox, spørg brugeren"-mønster som de native
fil-dialoger og AltGr-tastatur-kvirken andetsteds i denne fil.

## Woowil-konto (valgfrit, per-profil login til den centrale konto-tjeneste)

Ny, separat tjeneste (`Trimlon/woowil-account`, se dens egen CLAUDE.md for
den fulde arkitektur) giver et centralt "Woowil-konto"-login på tværs af
browser/mail/en standalone "Woowil Konto"-app - helt valgfrit, aldrig et
krav for at bruge browseren.

- **Per-profil, ikke globalt** - `src/profile-store.js`'s
  `getWoowilAccount(id)`/`setWoowilAccount(id, account)`/
  `clearWoowilAccount(id)` gemmer `{userId, email, username,
  encryptedToken}` direkte i den enkelte profils post i `profiles.json`
  (samme fil som `passwordHash`) - matcher at alt andet her allerede er
  profil-scopet, og lader forskellige lokale profiler uafhængigt linke
  nul-eller-én Woowil-konto.
- **Genbruger den eksisterende `encryptPassword`/`decryptPassword`**
  (allerede generiske `safeStorage`-wrappere fra password manager-
  funktionen, ikke adgangskode-specifikke) til at kryptere session-tokenet
  før det rammer disken - ingen ny lokal krypteringsvej bygget.
- **To login-veje, samme lokale "adopter en session"-logik**:
  `loginWoowilAccount(identifier, password)` (kaldt fra panelets egen
  formular via `woowil:account-login`-IPC) og `checkWoowilAccountPendingFile()`
  (kaldt ved vinduesopstart og hver gang panelet åbnes) ender begge i
  `adoptWoowilAccountSession(profileId, token, user)`. Den sidste tjekker
  `~/.config/woowil-account/pending/browser.json` - en delt, OS-niveau-
  mappe (IKKE inde i denne apps egen `userData`), som den separate
  "Woowil Konto"-manager-app dropper en token i, så den kan logge browseren
  ind uden at spørge om adgangskoden igen. Se woowil-account-repoets
  CLAUDE.md for hele handoff-designet.
- **Log ud er ikke-destruktivt** - `logoutWoowilAccount()` rydder kun
  selve konto-linket (`store.clearWoowilAccount`), rører aldrig bogmærker/
  adgangskoder/historik.
- **Arver den kendte, udokumenterede `safeStorage`-hæng-risiko** fra
  password manager-funktionen ovenfor - ingen ny afhjælpning forsøgt her.
- **Verificeret live** (mod en lokal dev-instans af woowil-account-
  backend'en): panel-login virker og gemmer et genuint krypteret (ikke
  klartekst) token i `profiles.json`, log ud rydder det korrekt, og
  pending-fil-handoff'et (simuleret som om manager-appen havde skrevet den)
  bliver korrekt samlet op ved panel-åbning og filen slettet bagefter.

## Sikkerhedsfund fra en review (rettet)

Tre reelle, ikke-teoretiske huller fundet ved en sikkerhedsgennemgang af
password manager-koden, alle rettet og verificeret live:

- **Path traversal → vilkårlig rekursiv filsletning i `ProfileStore.
  removeExtensionEntry()`** (`src/profile-store.js`) - `fs.rmSync(...,
  {recursive:true, force:true})` kørte tidligere ubetinget på en sti bygget
  fra `storageId`, uden at tjekke at id'et matchede en reelt installeret
  udvidelse, og uden den samme "bliv-inden-for-mappen"-kontrol som
  `servePage()` allerede har. Nås via `window.woowilPages.
  removeExtension(storageId)`, tilgængelig fra al JS med fodfæste på en
  `woowil://`-side. Rettet med to spærringer: (1) no-op hvis `storageId`
  ikke matcher en eksisterende post, (2) samme `startsWith(extensionsDir +
  path.sep)`-indeslutningstjek som `servePage()`. Samme mangel fandtes i
  `setExtensionEnabledPage()` (`src/main.js`) - kunne indlæse en vilkårlig
  mappe som "udvidelse" - rettet med samme to spærringer.
  **Verificeret live**: et angreb med `storageId =
  "../../../../../../tmp/pwned-canary-dir"` mod begge funktioner returnerer
  nu uændret liste og rører aldrig filsystemet udenfor `extensions/` (en
  kanariefil udenfor blev bekræftet urørt); normal aktiver/deaktiver/fjern
  af en rigtig installeret udvidelse (testet mod den ægte Bitwarden-
  udvidelse) virker uændret.
- **CSV-formula-injection i adgangskode-eksport** (`csvField()` i
  `src/main.js`) - et brugernavn fanges verbatim fra et login-felt på en
  hvilken som helst besøgt side (se `pages-preload.js`), så en ondsindet
  side kunne plante en "credential" hvis brugernavn er en
  regnearks-formel-payload (`=HYPERLINK(...)` osv.) - klassisk OWASP
  CSV-injection, rammer hvis den eksporterede fil åbnes i Excel/
  LibreOffice/Sheets. Rettet ved at prefixe enhver værdi der starter med
  `=`/`+`/`-`/`@`/tab/CR med et foranstillet `'`, som neutraliserer
  formlen uden at ændre den synlige værdi for normale felter.
  **Verificeret** (isoleret enhedstest af selve funktionen, da hele
  eksport-flowet kræver et rigtigt `safeStorage`-kald som hænger i dette
  sandboxede miljø - se ovenfor): formel-payloads får korrekt `'`-prefix,
  normale værdier og eksisterende anførselstegn-escaping er upåvirket.

## Filoversigt

- `src/main.js` — main-process. Alt: vinduer, faner, arbejdsområder, profiler,
  downloads, adblock, permissions, auto-updater, extensions, alle
  IPC-handlers.
- `src/preload.js` — `window.woowil` API til toolbaren. IKKE brugt direkte
  som preload længere — se `toolbar-preload-entry.js`.
- `src/toolbar-preload-entry.js` — `require()`'r `preload.js` +
  `electron-chrome-extensions/browser-action`; bundles til
  `src/toolbar-preload.bundle.js` (git-ignoreret) af
  `scripts/bundle-preloads.js`, som er det toolbar-`WebContentsView`'en
  reelt bruger som sin `preload`.
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
  inkl. `extensions/` (installer/liste/fjern udvidelser) og `passwords/`
  (liste/vis/fjern/eksportér gemte adgangskoder).
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
   (`app-update.yml`) så den kan læse releases uden brugeren er logget ind.
   Alle der pakker appen ud kan læse denne token igen — det er accepteret,
   fordi den kun kan læse, aldrig skrive.

Ingen af tokens'ene er gemt noget sted i repoet eller i min hukommelse —
brugeren har dem, og skal give dem igen hvis en ny udgivelse skal laves.
**`GH_RUNTIME_TOKEN` har en udløbsdato på GitHub** (brugeren har tidligere
glemt at sætte "No expiration"/lang dato) — hvis auto-opdatering pludselig
holder op med at virke for alle brugere på én gang, tjek om denne er udløbet
først. Se `README.md` → "Auto-opdatering" for den fulde opsætningsguide.

**Repoet blev gjort offentligt og GPL-3.0-licenseret** (brugerens eget
bevidste valg — se `LICENSE`/`README.md` → "Licens"). `build.publish.private`
i `package.json` er sat til `false` til at matche. `GH_RUNTIME_TOKEN` er
teknisk set ikke længere *nødvendig* (et offentligt repos releases kan
læses uden token), men skader ikke at blive ved med at bruge — den er
stadig kun read-only. Fuld git-historik blev tjekket for lækkede tokens
(`git log --all -p` grep'et for `ghp_`/`github_pat_`-mønstre) **før**
repoet blev slået offentligt — fandt intet, men husk samme tjek hvis der
nogensinde er tvivl om historikken igen.

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

**AppImage-artefaktet hedder bevidst `Woowil.AppImage`, ikke
`Woowil-${version}.AppImage`** (sat via `build.linux.artifactName` i
`package.json`) — electron-builders standardnavn INKLUDERER versionen, men
det ødelægger auto-opdatering i praksis. Fundet ved at læse
`electron-updater`s egen kilde (`AppImageUpdater.js`, `doInstall()`) efter
brugeren rapporterede at deres skrivebords-genvej døde ved hver
opdatering: hvis filnavnet på den kørende AppImage matcher `\d+\.\d+\.\d+`,
sletter opdateringen den GAMLE fil og opretter en NY med det nye
versionsnummer i navnet i stedet for at overskrive samme sti — enhver
genvej der peger på det gamle filnavn er død i samme øjeblik. Med et
versionsløst navn overskriver `autoUpdater.quitAndInstall()` altid præcis
samme fil/sti, for evigt. Bagside: GitHub-assetet hedder nu det samme
(`Woowil.AppImage`) for hver eneste release — versionen kan stadig ses på
selve release-siden/taggen, bare ikke i filnavnet man downloader.
**Woowil OS's eget `woowil-install-own-browser.sh` (i `woowil-os`-repoet)
har en `ls .../Woowil-*.AppImage`-glob der forudsætter det GAMLE,
versionerede navn** — det skal opdateres/omgås når/hvis en fremtidig
browser-opdatering skal staged ind i en ny woowil-os ISO, ellers matcher
globen ingenting.

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
- GitHub: **offentligt** repo `Trimlon/woowil-browser` (GPL-3.0-or-later
  siden v0.2.6), gren `main`.
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
