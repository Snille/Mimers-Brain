# Historik

*[English](history.md)*

Vad som byggts, varför, och vad som gick fel på vägen. Nyast överst.

---

## 2026-08-04 — Mimers Brain byggt och driftsatt

Hela systemet kom till på en dag. Det ärver namnet från sin föregångare: en
molnbaserad [OB1](https://github.com/NateBJones-Projects/OB1)-installation på
Supabase som också hette Mimers Brain. Under bygget kallades det nya "Mimers
Valv" efter den skyddade nivån, men valvet är bara en nivå inuti hjärnan — inte
hela systemet — så namnet gick tillbaka. Spår av "valv" sitter kvar i
containernamn, volym och SSH-alias, och är medvetet lämnade i fred: de är interna
identifierare, och ett byte hade riskerat databasen utan att ge något.

### Varför flytten

Molnvarianten fungerade, men två saker talade emot att lägga hemligheter där:
varje sparat minne skickas till OpenRouter för embedding och metadata-extraktion,
och MCP-endpointen är en publik URL bakom en enda nyckel. Behörighetsfiltret i
Claude Code sa i praktiken samma sak — tre av de första inläggen med
credential-liknande innehåll nekades rakt av.

Slutsatsen blev en självhostad databas på Proxmox, med en nivå som
aldrig lämnar det privata nätverket.

### Arkitekturvalet som betyder mest

Nivåuppdelningen sitter i **lyssnaren**, inte i requesten. Port 8790 serverar
öppet + valv, port 8791 bara öppet, och MCP-servern på 8791 byggs helt utan
förmågan att nå valv-rader. Alternativet — att läsa `X-Forwarded-For` och avgöra
om anropet kom inifrån — förkastades: headern kan sättas av vem som helst, och då
hade en enda rad räckt för att lyfta ut hela valvet.

`test-isolation.ps1` bevakar gränsen med elva kontroller. Alla gröna, både lokalt
och mot den driftsatta servern.

### Vad som byggdes

- Postgres 17 med pgvector, samma `thoughts`-schema som OB1 plus en `tier`-kolumn
- MCP-server i Node utan beroenden utöver SDK:n och `pg`, två lyssnare i samma process
- Webbgränssnitt med sökning (text + semantisk), filter, inline-redigering
- `backup.sh` + cron: daglig `pg_dump`, tio dagars historik
- Migrering av 23 minnen ur gamla brain:et, projektminnen, `info.txt` och `ATKOMST.md`

### Fem fällor som kostade tid

**OB1:s schema var halvinstallerat.** Läsning och sökning fungerade, men
`capture_thought` föll på att `upsert_thought` saknades — hela steg 2.6 ur
setup-guiden hade aldrig körts. Lagat med en idempotent migration innan flytten
ens började.

**`ssh-keygen -N '""'` i PowerShell** sätter lösenfrasen till två bokstavliga
citattecken. Symptomet var `ssh -v` som sa *"Server accepts key"* och ändå nekade
— vilket betyder att den publika nyckeln är rätt installerad och felet är lokalt.
Två timeouts gick åt innan `-o BatchMode=yes` användes, som hade felat direkt.

**AppArmor i oprivilegierad LXC.** Visade sig som `npm install ... exit code 1`
mitt i ett bygge, alltså som ett nätverksfel. Det riktiga felet stod högre upp:
`runc run failed: unable to apply apparmor profile`. Körning löstes med
`security_opt`, bygget krävde en rad på Proxmox-värden.

**`Invoke-RestMethod` kodar bodyn som ISO-8859-1** om charset saknas på
`-ContentType`-parametern. Alla sexton importerade minnen fick U+FFFD där å, ä
och ö skulle stått, med embeddings beräknade på den trasiga texten. Det syntes som
konstiga tecken i konsolen, avfärdades som ett renderingsproblem, och det var
**Erik som upptäckte att datan faktiskt var förstörd**. Läxa: kontrollera
mottagarsidan, inte konsolen — `select count(*) filter (where content like
'%'||chr(65533)||'%')` ska vara noll.

**Ett falsklarm om läckage.** Det första proxytestet rapporterade att valvet syntes
utifrån. Det gjorde det inte — sökmönstren `VALV` och `MagicMirror` matchade
*öppna* minnen. Kontrollerat om med sex strängar som bara finns i valvnivå.

### Justeringar efter mätning

Tröskeln för semantisk sökning sänktes från OB1:s 0,5 till **0,3**. Mätt mot
svenska omskrivningar: identisk mening 1,00, delade nyckelord 0,79, omskrivning
utan gemensamma ord 0,43. Med 0,5 föll den sista tyst bort, vilket är precis den
träff minnet finns till för.

Webbgränssnittet krävde också en riktig inloggning. Det anropade `/api/*` som
bara tog bearer-nyckel, och en webbläsare skickar ingen sådan — sidan hade aldrig
fungerat för en människa. Nu byts nyckeln mot en HttpOnly-cookie, och utifrån
sköter Authelia det.

### Uppsättning runt omkring

- LXC på `192.0.2.41`, Ubuntu 26.04, Docker 29.7.1, NOPASSWD-sudo för `mimer`
- `brain.example.net` genom Nginx Proxy Manager mot 8791, med `/mcp` utanför Authelia
- Registrerad i Claude Code som `mimers-brain` (LAN, full) och `mimers-brain-remote`
- Ikon från Eriks sticker-PNG: frilagd med flood fill från hörnen, tre storlekar
- Supabase-projektet frånkopplat men vilande som fallback

### Versionshantering

Fram till nu hade servern fått sina filer styckvis med `scp`, i fyra omgångar, och
hade hunnit driva isär från laptopen: tio filer saknades och en dubblett låg och
skräpade i fel katalog. Ingen kunde säga vad som faktiskt körde.

Repot ligger nu på `Snille/Mimers-Brain`, och servern är en riktig klon som
används för driftsättning. Uppdatering är ett kommando:

```bash
ssh valv 'cd ~/mimers-brain && git pull && docker compose up -d --build'
```

Vid namnbytet dök en fälla upp som hade kunnat kosta hela databasen: Compose
härleder projektnamnet ur katalognamnet, och volymen heter
`mimers-valv_valv-data`. En omdöpt katalog hade tyst skapat en ny, tom databas.
Löst med `name: mimers-valv` hårdlåst i compose-filen — därav att containrar,
volym och SSH-alias fortfarande bär det gamla namnet.

Åtta minnen pekade dessutom på `/home/mimer/mimers-valv/`, en sökväg som inte
längre finns. De är omskrivna och omembeddade. **Ett minne som pekar fel är värre
än inget minne** — nästa session hade följt sökvägen rakt in i väggen.

### Ämnens skiftläge

Verifieringen av översättningen avslöjade en verklig defekt. Metadata-extraktorn
hade producerat både `Home Automation` och `home automation` för samma sak, så de
filtrerade som två skilda fasetter i gränssnittet — och statistikobjektet fick
nycklar som bara skiljde sig i skiftläge, vilket PowerShells `ConvertFrom-Json`
vägrar hantera och tyst returnerar råsträngen för i stället för ett objekt. Det
var därför isoleringssviten plötsligt rapporterade en tom summa.

Ämnen trimmas, gemenerseras och dedupliceras nu vid skrivning; personer behåller
sitt skiftläge eftersom de är egennamn. Tjugofem befintliga rader normaliserades
på plats. Embeddings beräknas från innehållet, inte metadatan, så inget behövde
embeddas om.

Sviten fick också en tolfte kontroll: den verifierar nu att den städat bort sina
egna testrader. En tidigare avbruten körning hade lämnat två kvar.

### Dokumentationsspråk

Dokumentationen var skriven på svenska rakt igenom, tvärtemot projektets egen
regel att kod, kommentarer och dokumentation skrivs på engelska just för att ett
repo ska kunna publiceras. Engelska är nu default, med den svenska texten kvar
som `*.sv.md`.
