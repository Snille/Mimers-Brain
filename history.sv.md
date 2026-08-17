# Historik

*[English](history.md)*

Vad som byggts, varför, och vad som gick fel på vägen. Nyast överst.

---

## 2026-08-17 — 0.9.7: en översättning är inte en främmande titel

Kontrollen i 0.9.5 mätte rakt ordöverlapp, och den första ärliga revisionen
visade vad det kostar: 32 rader flaggade, och den som stickprovades var en
korrekt ENGELSK sammanfattning av ett svenskt minne. En trogen översättning
delar nästan inga ord med sin källa, och den här databasen är tvåspråkig med
flit, så kontrollen hade bytt ut bra sammanfattningar mot mekaniska på 28 rader.

Kontrollen jämför nu ankare i stället — produktnamn, identifierare, sökvägar,
siffror och ord på åtta tecken eller mer, alltså det som överlever en
översättning. `ESPHome`, `WSL2` och `Docker` finns på båda språken; `Wi-Fi` och
`mesh` finns varken i den svenska eller engelska formuleringen av ett minne om
people-facetten. Ett förslag som bär ankare men inget av minnets egna handlar om
något annat. Ett förslag utan ankare lämnas i fred, eftersom det inte finns
något att bedöma det på.

Lärdomen är värd att behålla: en vakt som infördes för att fånga ett observerat
fel kalibrerades på just det fallet, och det var första fulla körningen mot
verklig data som avslöjade dess blinda fläck. Kör revisionen innan du litar på
vakten.

## 2026-08-17 — 0.9.6: revisionen talar sanning igen

`npm run audit` körde den avslutade v2-migreringen i torrkörningsläge. Den var
tänkt att rapportera noll och gjorde det efter 0.7.1, men hade glidit till 185
av 255 rader och gick inte längre att lita på. Tre skäl, alla inbyggda: den
härleder `verified_at` ur valfritt datum nära ett nyckelord och
`valid_for_version` ur valfri versionssträng, så nya minnen ger alltid nya
förslag; den bär hårdkodade titel-, sammanfattnings- och kind-överstyrningar
för tretton ID:n, varav flera nu är superseded historik; och den normaliserar om
legacy-rader utan origin, vilket stämplar dem `legacy` och därmed ger
`can_use_as_instruction`. En revision får inte tyst befordra 86 minnen till
instruktioner.

Migreringen är genomförd och finns kvar i git-historiken, så filen är borttagen.
`npm run audit` är nu `renormalise.mjs --all --dry-run`, som svarar på den enda
fråga som är värd att ställa — vilka rader skrevs före dagens vakter — och är
idempotent av konstruktion, eftersom den bara kör om de fyra visningsfacetterna
och inte härleder något ur att tiden går.

Värt att notera: det borttagna skriptet visste redan att Claude, Luba, Mimer och
Snille inte är personer. Den kunskapen låg i en engångsmigrering i stället för i
`memory-model.mjs`, där varje skrivning passerar. En regel på fel plats är samma
sak som ingen regel.

## 2026-08-17 — 0.9.5: servern avgör vem som är en person, och titeln måste stämma

Två fel i metadata-extraktionen kom fram under en städning av hela minnet.

Facetten `people` hade samlat på sig `Claude Code`, `Mimers Brain`,
GitHub-kontot `Snille`, relationsetiketterna `Eriks dotter` och
`Erik's brother`, samt `Erik Bildmak` — ett namn modellen byggt av frasen
"Eriks bildsmak". Prompten bad redan om enbart människor; modellen struntade i
det. Den verkliga orsaken var en asymmetri: `topics` valideras mot en
kontrollerad ordlista i servern, medan `people` bara deduplicerades och togs rakt
av från modellen, med ett enda hårdkodat undantag för `Luba`. Undantaget är nu
`resolvePeople()`, som översätter relationsetiketter till riktiga namn, flyttar
kända tekniska namn till `systems`, tar bort det som redan är indexerat som
system i samma minne, och kastar varje återstående namn som varken är en känd
person eller står ordagrant i minnestexten. En kollega som nämns i texten
överlever.

Extraktionsmodellen returnerade dessutom en titel och sammanfattning som hörde
till en helt annan text: minnet som definierar people-facetten sparades som
"Mäta och optimera Wi-Fi-nätverket hemma", med matchande ämne och projekt.
Innehållet var intakt, men ett minne väljs utifrån titel och sammanfattning, så
det hade blivit osökbart. `describesContent()` avvisar nu en föreslagen titel
eller sammanfattning som delar mindre än 20 % av sina betydelsebärande ord med
minnet, och faller tillbaka på de deterministiska `deriveTitle()` och
`deriveSummary()` som redan fanns. Kontrollen står tillbaka för korta minnen,
där signalen är för svag.

## 2026-08-09 — 0.9.4: historiska minnen lämnar granskningskön

Ett agentminne från 0.9.1 låg kvar som väntande granskning trots att det redan
var ersatt av 0.9.2 och 0.9.3. Kön, statistikens väntande-KPI och MQTT-räknarna
filtrerade bara bort `archived` och tog därför felaktigt med `superseded`.
Samtliga använder nu samma definition: bara `lifecycle: current` kan kräva en
granskning. Historiska poster behåller sin ursprungliga granskningsstatus för
spårbarhet men visas inte som något användaren behöver åtgärda.

## 2026-08-09 — 0.9.3: fetch visar aktualitet före lång minnestext

Claude hämtade ett ersatt serverinventarium vars text var skadad och drog
slutsatsen att ingen intakt kopia fanns. Historiken innehöll i själva verket den
fullständiga formuleringen, men `fetch` lade den långa texten före livscykel och
relationer; en avkortad verktygsvisning kunde därför dölja både
`lifecycle: superseded` och `superseded_by`. `fetch` och `fetch_thought` placerar
nu `lifecycle`, `is_current`, `superseded_by`, aktualitetsinstruktion och
relationer före innehållet. Ett historiskt ID säger uttryckligen åt klienten att
hämta ersättaren innan posten används som aktuell kunskap.

## 2026-08-09 — 0.9.2: varje sökning kräver ett eget kvitto

Ett test med Claude Code visade ett nytt gränsfall: modellen gjorde två
sökningar men rapporterade bara den sista. Minnespolicyn och båda verktygsytorna
säger därför nu uttryckligen att varje icke-tom sökning ska rapporteras exakt en
gång före slutsvaret, att flera sökningar kräver separata rapporter och att även
helt ignorerade resultat ska kvitteras. JSON-svar innehåller dessutom
`receipt_required` och en konkret `receipt_instruction`; MCP-svaret upprepar
kravet direkt efter varje `trace_id`.

## 2026-08-09 — 0.9.1: sökning och kvitto använder samma ID

OpenAPI-sökningen returnerar nu `trace_id`, exakt det fältnamn som
`report_memory_usage` tar emot. Det tidigare `request_id` finns kvar med samma
värde som bakåtkompatibelt alias. MCP-sökningen benämner också värdet uttryckligen
som `trace_id`, och den gemensamma minnespolicyn samt användarguiderna beskriver
hela kvittoflödet. Därmed lämnar klienter inte längre sökningar som "väntar på
rapport" bara för att sök- och rapportverktygen använde olika namn på samma UUID.

## 2026-08-09 — 0.9.0: statistik mäter minnets hälsa, inte bara trafiken

Statistiksidan börjar nu med det som faktiskt går att använda: aktiva minnen,
granskningskön, saknade embeddings och metadata, kvittotäckning och försenad
klientrapportering. Alla databasrader redovisas separat som poster inklusive
historik, så en arkiverad importkälla, ett avvisat minne eller en ersatt
föregångare blåser inte längre upp ett KPI som påstår sig visa användbara minnen.
Diagrammen över skapade poster delas av samma skäl upp efter om posten fortfarande
är aktiv eller nu är inaktiv.

De integritetssäkra återkallningsspåren har fått egna dagsdiagram och en tabell
per klient. Kvittotäckning är rapporter delat med sökningar; nytta är använda
UUID:n delat enbart med returnerade UUID:n från spår som verkligen rapporterats,
så ett okänt resultat kallas inte tyst oanvänt. Sidan börjar uttryckligen denna
historik med det första 0.8.0-kvittot och behandlar aldrig äldre anrop som saknade
rapporter. Frågor, svar och minnesinnehåll saknas fortfarande helt i både
telemetridatabasen och gränssnittet.

De befintliga vyerna för aktivitet, klienter, verktyg och MQTT finns kvar, nu
grupperade efter minneshälsa och återkallningskvalitet. Verktygsstatistiken visar
även fel och p95-svarstid. MQTT-hälsan för försenade kvitton omfattar nu alla
bevarade öppna spår i stället för att glömma ett saknat kvitto vid midnatt.
Layouten renderades i en riktig webbläsare och SQL:en kördes mot en isolerad
pgvector-databas, inklusive bevis för att den öppna lyssnaren inte kan summera
valvposter eller full-lyssnarens kvitton. Ett lastprov med 20 000 minnen,
150 000 användningshändelser och 10 000 återkallningsspår returnerade hela
Statistik v2-svaret på cirka 235 ms på utvecklingsmaskinen. Samtliga 24
Node-tester och alla 55 skrivande smoke-kontroller i container passerar.

---

## 2026-08-09 — 0.8.0: agentminnet blir ett styrt minne

Minnen lagrar nu varifrån de kommer, hur säkra de är och vad en modell får göra
med dem. Agentens egna slutsatser börjar som väntande evidens i stället för att
tyst bli användarinstruktioner. En betrodd granskning kan bekräfta, begränsa,
markera gammalt, behålla som evidens eller avvisa dem, medan käll- och
artefaktreferenser följer med posten.

Längre källtext behöver inte längre bli ett enda transkriptformat textblock.
Smart import föreslår först fristående atomära minnen, sparar ingenting före
godkännande, arkiverar sedan originalkällan och länkar varje accepterat minne
med `derived_from`. Den nya sidan Granska visar även semantiska nästan-dubbletter
med uttryckliga val för att behålla, relatera, ersätta eller slå ihop; ingenting
slås ihop eller tas bort automatiskt.

Sökningar returnerar nu ett integritetssäkert återkallningskvitto. Klienter kan
rapportera vilka returnerade UUID:n som faktiskt påverkade svaret utan att
lagra frågan, svaret eller minnesinnehållet. Den centrala MCP-/OpenAPI-policyn
förklarar samma tillits- och rapporteringsregler för alla modeller.

Home Assistant-discovery innehåller nu granskningskön och samlad täckning för
återkallningskvitton, enbart som räknare. Ett kvitto som förblir öppet längre än
tio minuter degraderar tjänstens status, så klienter som söker men aldrig
rapporterar blir synliga. Den tillhörande TokenTracker 1.8.0 visar väntande
granskningar och dagens kvot mellan kvitton och sökningar utan att exponera
frågor eller minnestext.

Smoke-testet är skrivskyddat som standard, kan lämna ren JSON och kräver
`-Write` för sina 48 canary-kontroller. Canary-rader städas i ett `finally`-block.
Tillsammans med 21 Node-tester kördes de nya flödena mot en riktig tillfällig
pgvector-databas före releasen.

---

## 2026-08-09 — 0.7.0: minnen blir poster i stället för incidentformade textblock

De första 84 minnena visade att bra innehåll inte räcker. Fria ämnesetiketter
hade gett 171 stavningar, avslutade arbeten låg som tasks, och en fråga om
aktuell SSH-åtkomst kunde placera det kanoniska svaret under kortare sidonoter.
Metadata v2 lägger till titel, sammanfattning, sort, livscykel, uppgiftsstatus,
projekt, system, verifieringsdatum och ett kontrollerat ämnesförråd, samtidigt
som gamla klienter fortfarande kan läsa fältet `type`.

Sökningen är nu hybrid: semantisk likhet är fortfarande grunden, men ordträffar
i titel och sammanfattning kan lyfta det kanoniska svaret. Överspelade minnen
döljs som standard men behöver inte längre förstöras. `supersede_thought`
skapar ersättaren, bevarar föregångarna och lagrar fullständiga UUID-relationer
som gränssnittet kan följa åt båda hållen.

Samtidigt rättades beskrivningen av valvet överallt. Det är till för känslig
kontext och exakta `SECRET_REF`-pekare, aldrig råa lösenord, tokens, API-nycklar
eller privata nycklar. Migreringskommandot använder `--dry-run` som utgångsläge,
vägrar skriva om det förväntade radantalet avviker, visar inget minnesinnehåll
och bevarar gamla specialetiketter under `legacy_topics`.

Gränssnittet visar de nya filtren och historiken, semantiska sökresultat använder
kompakta titel-/sammanfattningskort, och testsviten kombinerar Node-enhetstester
med 36 isolerings- och historikkontroller mot en riktig testcontainer.

---

## 2026-08-09 — 0.6.0: en andra dörr, för klienter som aldrig lärt sig MCP

Open WebUI kan anropa externa verktyg, men den läser ett OpenAPI-dokument och
anropar vanlig REST; den har ingen aning om vad JSON-RPC över `/mcp` är, och
ingen inställning får den att lära sig. Det vanliga svaret är en proxy framför —
Open WebUI levererar en — men det är ännu en tjänst att köra, uppdatera och
glömma bort, som lindas runt en server som redan mycket väl vet vilka verktyg den
har. Så hjärnan beskriver sig själv istället: `GET /openapi.json` och en
`POST /tools/<namn>` per verktyg, på båda lyssnarna, bakom samma nyckel.

Tier-regeln behövde inte så mycket upprepas som bevisas om. Ingenting i den nya
ytan når längre än den lyssnare den kör på: den öppna lyssnarens dokument nämner
inte `delete_thought`, erbjuder inget `vault`-värde för `capture_thought`, och
vägrar hämta en valvrad via id. `test-isolation.ps1` kontrollerar alla tre, plus
att `MCP_OPEN_KEY` fortfarande stannar vid `/mcp` — en URL-nyckel finns för
dialoger utan plats för en header, och en OpenAPI-verktygsserver har ett alldeles
utmärkt fält för en.

`/openapi.json` serveras utan nyckel med flit. Det är verktygsnamn och
argumentscheman, vartenda ord redan publicerat i det här repot, och en klient som
inte kan läsa dokumentet innan den fått en nyckel går inte att konfigurera alls.

Den enda verkligt nya exponeringen är CORS, eftersom webbläsaren hämtar
dokumentet från sidans egen origin. `CORS_ORIGINS` listar de origins som får
fråga, och är tom som standard; en origin som inte står med får inga
CORS-headers och webbläsaren vägrar svaret. Nginx får inte lägga på en andra
uppsättning headers — en dubblerad `Access-Control-Allow-Origin` avvisas rakt av,
vilket ser exakt ut som att servern saknar CORS helt.

Vad det kostar: två beskrivningar av samma sex verktyg, en i `mcp.mjs` för en
modell att läsa och en i `openapi.mjs` för ett program att tolka. Att slå ihop
dem prövades på papper och övergavs — formerna skiljer sig på riktigt, och priset
för att ena dem var en omskrivning av den fil varenda befintlig klient hänger på.
Att lägga till ett verktyg innebär nu att lägga till det på båda ställena; båda
filerna säger det.

---

## 2026-08-08 — 0.5.1: ett minnesantal är en mätare, inte ett räkneverk

De fyra fönsterräknarna för minnen — dag, vecka, månad, år — publicerades till
Home Assistant med `state_class: total_increasing`, vilket lovar att värdet bara
kan stiga och att varje fall är en nollställd räknare. Raderade minnen bryter
det löftet, och Home Assistant sa ifrån: *"has state class total_increasing, but
its state is not strictly increasing"*, efter att en städrunda tagit bort tre
överspelade minnen och årsantalet sjunkit. Varje sådant fall registrerades som
början på en ny cykel och förstörde tyst långtidsstatistiken bakom sensorerna.
Nu är de `measurement`, vilket är vad ett antal som kan röra sig åt båda hållen
faktiskt är. Anropsräknarna behåller `total_increasing` med flit: ett anrop som
redan gjorts kan inte ogöras, så de kan bara stiga inom sitt fönster.

---

## 2026-08-07 — en installation, tre sorters värdar

Den korta Compose-snuttan växte till en komplett installationsguide för Proxmox
LXC, Docker Desktop och en befintlig Ubuntu Server. Den tar med felen som först
syntes i riktig drift: AppArmor-fel maskerade som misslyckade byggsteg,
Docker-portar som passerar enklare brandväggsantaganden, det låsta
Compose-namnet som skyddar datavolymen och skillnaden mellan att stoppa en stack
och att radera den med `-v`. Backupskriptet accepterar nu också värdsidans
överskrivningar för katalog, retention och databasidentitet, så ett tjänstekonto
som inte heter `mimer` slipper hålla en lokalt redigerad variant av skriptet.

---

## 2026-08-06 — 0.5.0: gränssnittet lär sig språk

Dokumentationen hade alltid funnits på engelska och svenska, men det levande
webbgränssnittet var enbart svenskt. Nu hämtas varje synlig etikett, text och
guide ur JSON-kataloger, webbläsarens språk väljs vid första besöket och ett
manuellt val sparas. Engelska är komplett fallback. Ett nytt språk kräver bara
en kopierad katalog och en rad i manifestet — ingen ändring i vyernas kod.

---

## 2026-08-06 — Tre saker minnet inte kunde berätta om sig självt

Hjärnan hade svarat troget i månader utan att kunna säga något om sin egen
tillvaro. Tre frågor hade inget svar: *hur kopplar jag in den här modellen?*
(svaret låg i ett dokument med platshållaradresser), *används den?*, och *lever
den?*

**Anslutningsguiden** blev en tredje vy i webbgränssnittet. Samma innehåll som
HowToUse, fast ifyllt av instansen själv — adresser, nycklar, verktygslista — med
kopieringsknappar. Dokumentet finns kvar för det en sida inte kan förklara:
varför en inställning ser ut som den gör, och hur servern byggs om.

Frågan som tog längst tid att svara på var vilka nycklar sidan får visa. Allt
ligger ju på ett privat nätverk och webbgränssnittet ligger alltid bakom
Authelia, så
resonemanget "någon oinloggad kan se den" håller inte. Men det är fel fråga. Rätt
fråga är *vart nyckeln tar vägen*: visas `MCP_ACCESS_KEY` på den proxade
lyssnaren lämnar valvnyckeln huset genom NPM, ut över internet och in i
webbläsarens cache varje gång sidan öppnas — och det är den enda credential som
låser upp valvet på LAN. Regeln blev därför att valvnyckeln bara serveras av
LAN-lyssnaren. `MCP_OPEN_KEY` visas på båda; den är gjord för att resa i URL:er
och når ändå aldrig mer än öppen nivå. Två nya kontroller i `test-isolation.ps1`
vaktar det.

**Statistiken** kräver att man är ärlig om vad som går att veta. MCP lämnar över
`clientInfo` i initialize-handskakningen och aldrig mer — och servern är
stateless, en färsk transport per HTTP-anrop, så när ett `tools/call` kommer in
är namnet borta. Lösningen blev en liten cache: kom ihåg vad initialize sa,
nycklad på avsändaradress plus user agent. Det innebar också att kroppen måste
läsas i servern i stället för av transporten, som tur nog tar emot en redan
parsad kropp just för sådana här fall.

Det som cachen ger är dock **klientappen** — Claude Code, Codex, en
ChatGPT-connector — aldrig vilken modell som svarar inuti den. Modellnamnet finns
helt enkelt inte på tråden. Gränssnittet säger det rakt ut i stället för att låta
en kolumn heta något den inte kan leva upp till.

Användningsloggen sparar medvetet **inget innehåll**: inte sökfrågan, inte
minnet, inte svaret. En trafiklogg som citerade valvsökningar tillbaka hade
upphävt hela nivådelningen den ligger bakom — och statistiken är läsbar från den
öppna lyssnaren. Av samma skäl räknar den vyn bara trafik som kom in på den
öppna lyssnaren, så den kan inte ens avslöja att valvtrafik existerar.

Två fällor på vägen. Dygnsbrytet måste räknas i lokal tid: lämnat i UTC hade
"i dag" rullat över vid ett- eller tvåtiden på natten och ett kvällsminne hamnat
på morgondagen — vilket ser ut som en bugg i diagrammet långt innan någon
misstänker tidszonen. Och API:t returnerar bara hinkar som haft aktivitet, vilket
är rätt på tråden och fel i ett diagram: två staplar en månad isär hade hamnat
sida vid sida, och en ensam lugn dag sträckte ut en stapel över hela kortet.
Serien görs tät i webbläsaren i stället, så en lugn dag är en lucka man ser.

**MQTT till Home Assistant** publicerar räknarna som HA-discovery under enheten
Mimers Brain. Poängen med availability-topicen är dess *last will*: dör processen
publicerar brokern `offline` åt den. Utan en sådan ser en död hjärna exakt ut som
en frisk som inte har något nytt att säga — precis den förväxling
Tokentracker-sensorerna en gång byggdes för att döda. Verifierat mot en
engångsbroker i Docker, både vid planerat stopp och vid hård kill.

Brokerlösenordet ligger i `.env`, inte i en inställningstabell i gränssnittet.
Databasen dumpas varje natt, och en credential som ändras med ett
`docker compose up -d` behöver inte ligga i backuperna också.

En detalj som kostade en omstart: variablerna måste räknas upp i
`docker-compose.yml` under `environment:`. En rad i `.env` når bara Composes egen
interpolering — den hamnar aldrig i containern av sig själv.

**0.4.2 — sidopanelen, inte listan.** Erik frågade om gränssnittet skulle bli
segt vid tusentals minnen. Att mäta slog att gissa: en lokal instans med 20 000
minnen och 150 000 användningsrader gav `/api/thoughts` på **7 ms** — den är
takad till 100 rader, så paginering hade inte löst något — och `/api/stats` på
**550 ms** för ett svar på 819 byte. Den senare är värre än den ser ut, eftersom
gränssnittet uppdaterar den vid varje tangentpaus i sökrutan.

Det intressanta var *var* tiden gick, för det var inte där någon av oss antog.
Postgres var oskyldig: att hämta hela tabellens metadata tar 43 ms, och att
aggregera samma sak i SQL tar 53 ms — alltså ingen vinst alls i databasen. De
återstående ~540 ms var drivrutinen som avkodade 20 000 JSONB-värden till
JS-objekt, plus loopen över dem. Så `stats()` räknar nu i SQL, och vinsten är
inte att SQL räknar snabbare: den är att svaret blir en rad i stället för
tjugotusen. Uppmätt efteråt: **60 ms**, och isolationssviten går fortfarande
igenom alla 22 kontroller.

Två detaljer värda att behålla. `jsonb_typeof`-vakterna är de gamla
`Array.isArray()`-kontrollerna — metadata är fritt formad, och en handredigerad
rad vars `topics` är en sträng får inte fälla hela anropet; det fallet täcks nu
av en testrad. Och `first`/`last` var tyst fel innan: den gamla koden sorterade
Date-objekt med standardjämföraren, som jämför dem som strängar och därmed
sorterade på veckodagens namn. Ingenting läser de fälten än, vilket är därför
ingen märkt det.

En fälla som gicks rakt in i på slutet, och som fångades bara för att samma sak
dokumenterats en gång förut: `problem`-texten hamnar på en ESPHome-display vars
fonter har en fast glyph-lista, och `|` finns inte i den. Ett tecken utanför
listan ritas som *ingenting* — det blir ingen ruta, det äter tyst upp en del av
meningen. Separatorn är ett snedstreck nu, och hela strängen körs genom samma
glyph-vokabulär före publicering, så ett databasfel fullt av skiljetecken
degraderas till punkter i stället för till ett meddelande med hål i.

Anslutningsguiden hade först en `LAN_URL` att fylla i för hand, och Erik
invände direkt mot att skriva in en IP som kan bli fel. Han hade rätt. Den
självklara lösningen fungerar dock inte: `os.networkInterfaces()` inne i
containern ger Dockers bryggadress, och `socket.localAddress` ger samma sak
eftersom porten är NAT:ad — auto-detektering hade alltså skrivit ut en adress som
inte fungerar för någon, vilket är sämre än ett tomt fält. Men det finns en källa
som inte kan ha fel på det sätt som spelar roll: `Host`-headern på LAN-lyssnaren
är per definition en adress en webbläsare precis kom fram på. Servern lär sig
alltså sin egen adress av riktiga besök och sparar den i en liten
`app_settings`-tabell så den överlever omstart. `localhost` och `127.*` sorteras
bort — sant, men värdelöst att räcka vidare till en annan maskin. `LAN_URL` finns
kvar som ren override.

---

## 2026-08-04 — En nyckel som får plats i en URL

Två klienter hade legat inlagda i Claude Code ett tag, och minnet svarade där
varje dag. Sedan gav ett försök att lägga in samma server på skrivbordsappens
chattsida *"Couldn't register with Mimers Brain's sign-in service"*.

Det första som måste redas ut var att Claude Code och Claude Desktop är **två
olika klienter som råkar dela fönster**. Code läser `~/.claude.json`; chatten
läser sin egen connector-lista. Ingen ser den andras, så att minnet fungerar i
den ena säger ingenting om den andra, och den tomma connectors-listan var aldrig
ett fel. Den distinktionen står nu i HowToUse — det är precis sådant som kostar
en timme exakt en gång per person.

Själva felet var att connector-dialogen inte har något fält för en header. Bara
OAuth Client ID och Secret. Får den en URL den inte kan autentisera mot faller
klienten tillbaka på OAuth-flödet, försöker registrera sig dynamiskt, och
misslyckas — servern har ingen OAuth alls.

### Vad som övervägdes

Att göra det ordentligt betyder att bli en OAuth-resursserver: RFC 9728-metadata,
en `WWW-Authenticate`-header som pekar på den, JWT-validering mot en providers
JWKS, och en provider som ställer ut tokens. Den befintliga autentiseraren hade
kunnat vara den providern — men dess OIDC-sida visade sig inte vara påslagen alls,
så det arbetet hade börjat från noll.

Det var mycket maskineri för en enda klients dialog, och det lades på hyllan
snarare än kastades: hela designen ligger i
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md), redo för den dag en
delad nyckel inte räcker längre.

### Vad som byggdes istället

`MCP_OPEN_KEY`, som tas emot som `/mcp?key=…` — men bara på den öppna lyssnaren,
bara på `/mcp`, och bara när variabeln är satt. Är den tom är servern bit för bit
densamma som förut.

Det viktiga är att det är en **andra** nyckel. En hemlighet i en URL sparas i
klientens config och skrivs till varje accesslogg i proxyn, och huvudnyckeln — den
som öppnar valvet på 8790 — får aldrig hamna i den positionen. Den öppna lyssnaren
kan inte nå valv-rader oavsett vad den visas, så det värsta den här nyckeln kan
läcka är öppen nivå. `/mcp` fick också `access_log off` så värdet inte skrivs till
disk vid varje anrop, och servern varnar vid uppstart om de två nycklarna någonsin
sätts till samma värde.

`test-isolation.ps1` växte med fyra kontroller runt det, där den som betyder mest
är att **den fulla lyssnaren vägrar URL-nyckeln**. En bekvämlighet som tyst hade
fungerat även på 8790 hade upphävt hela tudelningen.

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

Slutsatsen blev en självhostad databas på Proxmox, med en nivå som aldrig lämnar
det privata nätverket.

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

Repot ligger nu på `Snille/Mimers-Brain`, och servern är en riktig klon.
Uppdatering är ett kommando:

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

### Commit-identitet

De första commitarna skapades med en oavsiktlig Git-identitet. Inför offentlig
publicering skrevs historiken om till underhållarens valda publika identitet.
Identiteten är nu fastlåst i repot och regeln dokumenterad: låt Git själv avgöra
författaren i stället för att ärva ett konto från den omgivande sessionen.

### Redigerbara taggar

Ämnen och personer gick bara att sätta när ett minne skapades. Att rätta en
felstavning eller slå ihop två stavningar krävde ett API-anrop för hand, så
redigeringsformuläret bär nu typ, ämnen och personer vid sidan av innehållet.

Bygget avslöjade en verklig lucka: normaliseringen låg inne i `captureThought`, så
allt som skrevs via `PATCH` gick förbi den helt och kunde återinföra
skiftlägeskrocken ovan. Den bor nu i `normaliseMeta()` och körs vid varje
skrivning. Formuläret utelämnar dessutom `content` ur anropet när det inte ändrats
— servern embeddar om så fort den ser fältet, och det är ett betalt anrop.

Samma defekt hade redan delat personfasetten: extraktorn producerade både `Erik`
och `Erik Pettersson` för en och samma person, så filtrering på endera missade
rader. Sammanslaget på plats; embeddings räknas på innehållet, så inget behövde
räknas om.

### Dokumentationsspråk

Dokumentationen var skriven på svenska rakt igenom, tvärtemot projektets egen
regel att kod, kommentarer och dokumentation skrivs på engelska just för att ett
repo ska kunna publiceras. Engelska är nu default, med den svenska texten kvar
som `*.sv.md`.
