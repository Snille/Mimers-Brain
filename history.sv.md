# Historik

*[English](history.md)*

Vad som byggts, varför, och vad som gick fel på vägen. Nyast överst.

---

## 2026-10-20 — 0.16.0: gränsvärdena hör till sin inbäddningsmodell

0.11.0 gjorde en ny inbäddningsmodell till några klick, men de två
likhetsgränserna följde inte med: sökning 0,3 och recall-hooken 0,5, båda
uppmätta med text-embedding-3-small. En poäng betyder bara något för modellen
som gav den, så efter ett byte var gränserna gissningar tills någon körde
`scripts/eval-recall.mjs` över SSH, ändrade `.env` och startade om.

Models-kortet har nu en del **Sökgränser**. Båda gränserna sparas i databasen,
ett sparat värde går före `RECALL_HINT_FLOOR` i `.env`, och en ändring gäller
utan omstart. Kortet visar vilken inbäddningsmodell gränserna sattes för och
varnar när det inte är den som används.

Mätningen körs från kortet i bakgrunden. Frågeuppsättningen laddas upp där som
samma JSON som skriptet läser; den sparas i databasen bredvid minnena den
handlar om, aldrig i git eller imagen, och bara på den fulla lyssnaren. Ett
resultat namnger frågor med id och minnen med UUID. Det föreslår gränser:
sökning är den lägsta poäng ett rätt svar fick, minus 0,1 (så kom 0,3 till);
gränsen för minnestips är den som visar rätt minne oftast minus hur ofta den
visar något för en fråga utan svar, och vid lika vinner den högre. Under en ny
inbäddning kan den nya modellen mätas på sina egna vektorer, och gränser som
sparas för den börjar gälla i samma steg som bytet. Avbryts körningen försvinner
de med den.

Skriptet och kortet delar en och samma mätning, `evaluate()` i
`recall-settings.mjs`. Gränserna för dubbletter (0,86) och motsägelser (0,6) är
fortfarande fasta.

Också i den här versionen: metadatamodellens standard är `openai/gpt-6-luna`.
OpenRouter stänger av gpt-4o-mini 2027-01-14. I ett jämförande test delade
Qwen3-235B en lång svensk anteckning i 30 minnen med kopior och två påhittade
fakta, och skrev svensk metadata för engelsk text; gpt-6-luna gav nio rena
minnen och behöll varje texts språk. Och knapparna på Models-kortet var dolda
tills pekaren var över kortet, eftersom `.card .actions` vann över kortets egen
regel; nu visas de alltid.

Dokumentationen kontrollerades mot koden och skrevs om kortare. README är nu en
översikt med en tabell över verktyg per port; designdetaljerna flyttade till
`docs/how-it-works.md` och MQTT-sensorerna till `docs/home-assistant.md`;
installation och anslutning finns var och en på ett ställe. Kontrollen hittade
verklig glidning: `MQTT_UNREPORTED_FAULT` var dokumenterad men skickades aldrig
till containern och hade alltså ingen verkan; `CORS_ORIGINS` och
`OLLAMA_API_KEY` saknades i `.env.example`; HowToUse väntade sig sex verktyg där
det finns tio, påstod att ändrade taggar inte bäddas in igen (det gör de), och
importguiden talade fortfarande om inloggningsuppgifter i valvrader, vilket
servern vägrat sedan 0.9.26.

## 2026-10-18 — 0.15.0: hjärnan går att stänga av, och gammalt väntande är historik

Kortet **Tillit och granskningsstatus** visade 45 minnen som väntande medan
granskningskön sa 0. Båda hade rätt: kortet räknar alla poster, och de 45 blev
ersatta eller arkiverade innan någon granskade dem. Sedan 0.9.4 kan bara ett
aktuellt minne kräva granskning, men kortet såg ändå ut som arbete som väntade
på Erik. Väntande är nu två staplar, **väntande, nya** och **väntande,
historiska**, och den nya visas även vid noll, eftersom noll är svaret.

Att rita 3D-hjärnan håller en CPU-kärna sysselsatt. Knappen **3D-hjärnan**
ovanför den stänger nu av den. Av betyder att inget ritas och att grafens fråga
inte körs; valet sparas per webbläsare i `localStorage`. Ett klick medan grafen
fortfarande laddar startar en nyare körning, och den äldre lägger sig inte
längre över den.

---

## 2026-10-14 — 0.14.1: ett minne går att peka ut

För att få en modell att rätta ett minne fick Erik ta en skärmbild av kortet
eller beskriva det och hoppas att sökningen hittade samma rad. Det enda id som
syntes på kortet var de 8 tecknen på knappen **Historik**, och det är id:t för
föregångaren, inte för minnet som visas. Varje kort har nu **Kopiera referens**,
som kopierar hela id:t och titeln som en rad att klistra in i en chatt med
vilken ansluten modell som helst, följd av vad som ska ändras. Hjälpfunktionen
för urklipp flyttade från sidan Anslut till `clipboard.mjs` så att båda sidorna
delar den.

---

## 2026-10-14 — 0.14.0: startpaketet säger vad det lämnar utanför

Startpaketet hade redan ett tak, 15 minnen eller 9 000 tecken, men det som
hamnade utanför försvann utan ett ord: modellen fick aldrig veta att det fanns,
och sidomenyns räkning av minnen i startpaketet tog med rader som ingen modell
läste. ai-memory håller sin profil för alla projekt till en fast storlek av det
skäl som gäller här också — varje modell läser den i varje session, och efter en
viss punkt gör varje ny regel att de andra väger mindre — och räknar det som
inte får plats.

Nu slutar `memory_digest` med de minnen som inte fick plats, med titel och id,
och säger att de fortfarande gäller och hittas med sökning. Svaret har
`omitted` och `omitted_items` för OpenAPI-klienter, och sidomenyn på sidan Tankar
varnar under **Startpaket** när något hamnar utanför. Hjälptexten för att fästa
ett minne säger vad som hör hemma där: skulle en modell göra fel utan det, i
många olika uppgifter? Det levande startpaketet hade 11 minnen, så inget
hamnar utanför i dag.

---

## 2026-10-14 — 0.13.1: betydelse väger tyngre än titelord

Den första ändringen som mätningen gjorde. En variant med mer vikt på betydelse
(0,80 i stället för 0,65) och mindre på gemensamma titelord (0,15 i stället för
0,30) låg före på startfrågorna, 83 % mot 75 % rätt minne först. Det bevisade
lite i sig, eftersom startfrågorna skrevs med minnena framför sig. En första
`/review-sessions`-genomgång tog därför fram åtta frågor som Erik faktiskt
ställt under veckan, var och en med det minne som sessionens kvitto markerade
som använt, plus en som inget minne ska svara på. På de åtta satte varianten
rätt minne först fem gånger, de gamla vikterna tre.

| 44 frågor med svar | hit@1 | hit@5 | MRR |
| --- | --- | --- | --- |
| 0,65 betydelse, 0,30 titel | 68 % | 98 % | 0,808 |
| 0,80 betydelse, 0,15 titel | 80 % | 98 % | 0,868 |

Hookens golv ligger kvar på 0,5. Vid 0,45 visar den rätt minne något oftare
(91 % mot 86 %) och fortfarande inget för de sju frågorna utan svar, men vid
0,40 börjar bruset, och sju frågor räcker inte för att hitta gränsen.

---

## 2026-10-14 — 0.13.0: sökträffar mäts i stället för att gissas

Varje tal i rankingen sattes för hand mot en handfull prov: 0,65 för betydelse,
0,30 för titelord, knuffen från kvittona, hookens golv på 0,5. Inget sa om nästa
ändring skulle hjälpa eller i tysthet göra saken sämre. Idén kommer från
[ai-memory](https://github.com/akitaonrails/ai-memory), där ingen
rankingändring slås på som standard förrän deras sökmätning säger ja.

`scripts/eval-recall.mjs` läser en frågeuppsättning från stdin — riktiga frågor,
var och en med de minnen som besvarar den, plus frågor som inget minne ska svara
på — och rapporterar hit@1, hit@5 och reciprok rang, och för recall-hooken, vid
golv från 0,40 till 0,60, hur ofta den visar rätt minne, bara fel minnen eller
brus. Vikterna blev `RANK_WEIGHTS` i `lib.mjs`, och `searchThoughts` tar emot
ändrade vikter och en färdig vektor, så att varianter jämförs i samma körning med
samma embeddings. Standardrankingen är oförändrad.

Frågorna hålls utanför git (`eval/*.local.json`) och utanför imagen, eftersom de
nämner riktiga system. En första uppsättning med 36 frågor som har svar och 6 som
inte har det skrevs utifrån de levande minnena; frågor från riktiga sessioner bör
ersätta den med tiden.

---

## 2026-10-14 — 0.12.1: att bekräfta ett minne tömmer inte längre titeln

Ett minne som bekräftades på sidan Granska kunde komma tillbaka med titeln
"Untitled memory" och en tom sammanfattning. `applyReview()` normaliserade
metadatan utan minnets text, och `describesContent()` avvisar en titel eller
sammanfattning som nämner ett id, en sökväg eller en version som texten saknar —
och en tom text saknar alla. Varje titel som nämnde `SETTINGS_KEY`, en fil eller
ett modell-id föll på det och ersattes med en titel härledd ur ingenting.

Ändringsloggen från 0.10.0 är det som gjorde felet synligt: den visade ett minne
som skapades med sin titel 14:17 och tömdes av `web-ui` 14:33, samma minut som
det bekräftades. En granskning av ett trettiotal minnen samma morgon hade gjort
detsamma med 23 av dem, innan ändringsloggen fanns. `applyReview()` tar nu emot
texten och normaliserar mot den, och lämnar metadatan orörd när texten saknas.

De 19 som dumpen från 00:10 fortfarande hade orörda fick tillbaka titel och
sammanfattning därifrån, och bara de tömda fälten fylldes i; de övriga fyra var
ersatt historik som granskats i september, och deras sammanfattningar härleddes
på nytt ur texten.

---

## 2026-10-14 — 0.12.0: leverantörsnycklar från webbgränssnittet

0.11.0 lät rutan Modeller välja modeller men höll alla leverantörsnycklar i
`.env`, med motiveringen att en nyckel inskriven på sidan skulle sparas i
`app_settings` och kopieras till varje nattlig `pg_dump`. Det stämmer, och det är
fortfarande skälet till hur den här versionen gör: rutan tar nu emot adresser
och nycklar för OpenRouter, OpenAI, Ollama och den egna servern, och förseglar
varje nyckel med AES-256-GCM under `SETTINGS_KEY` innan den sparas. Dumpen
innehåller chiffertext som är oanvändbar utan `.env`, och `.env` förvaras med de
andra hemligheterna.

Nyckelfältet går bara att skriva i. Rutan får veta om en nyckel finns och
varifrån den kommer (`.env` eller vald här) men aldrig själva nyckeln, inte ens
de sista tecknen; ett tomt fält vid sparning behåller det som finns, och *Ta bort
värden satta här* faller tillbaka på `.env`. Inget sparas förrän ett riktigt
anrop med de nya värdena har listat leverantörens modeller, så en felskriven
nyckel eller adress nekas direkt, och en leverantör som aldrig svarar ges upp
efter tio sekunder i stället för att låsa sidan. Feltext från en leverantör
rensas från allt som liknar en nyckel innan den visas, eftersom OpenAI citerar
nyckeln den fick. En ändrad `SETTINGS_KEY` gör sparade nycklar oläsbara; rutan
säger det och ber om dem igen i stället för att gissa.

---

## 2026-10-14 — 0.11.0: modeller väljs i webbgränssnittet

Vilken leverantör och modell varje uppgift använde låg i `.env`, och den enda
modell som faktiskt hade bytts — motsägelsedomaren — byttes med en ändring, en
commit och en deploy. Sidan Anslut har nu rutan **Modeller** på LAN-lyssnaren:
inbäddnings-, metadata- och motsägelsemodellen, var och en med en leverantör, en
modell vald ur leverantörens egen lista (med pris där OpenRouter publicerar det)
och en *Testa*-knapp som gör ett riktigt anrop innan något sparas.

Leverantörerna kommer från miljön: OpenRouter, OpenAI (`OPENAI_API_KEY`), Ollama
(`OLLAMA_URL`) och en egen OpenAI-kompatibel server (`CUSTOM_AI_URL`). Nycklarna
passerar aldrig webbläsaren: en nyckel inskriven i gränssnittet skulle sparas i
`app_settings` och kopieras till varje nattlig `pg_dump`, precis där regeln för
hemligheter säger att den inte får hamna. En leverantör utan nyckel visas men går
inte att välja. En gammal `.env` med `EMBED_URL` eller `META_URL` fungerar som
förut; de blir egna leverantörer.

De två chattmodellerna byts direkt. Inbäddningsmodellen kan inte det: varje
lagrad vektor hör till modellen som gjorde den, och bge-m3 till exempel svarar
med 1024 dimensioner där text-embedding-3-small har 1536. En ny inbäddningsmodell
fylls därför i en andra kolumn, `embedding_next`, i omgångar i bakgrunden, medan
sökningen använder den gamla kolumnen. En ändring under körningen nollställer
radens nya vektor så att den görs om. När alla rader är klara erbjuder rutan en
jämförelse — en fråga, de fem bästa från varje modell — och *Byt*, som tar bort
den gamla kolumnen, döper om den nya och bygger om HNSW-indexet i en enda
transaktion (över 2000 dimensioner, där HNSW tar slut, blir kolumnen utan index).
*Avbryt* tar bort den nya kolumnen och ändrar inget. En körning som avbryts av en
omstart fortsätter vid start. Nattkörningen ger nu också en vektor till varje
aktuellt minne som saknar en.

En ny vektor är ingen ny version av ett minne. Hittills flyttade varje UPDATE
`updated_at`, och dubblettbeslut och motsägelseutlåtanden gäller bara så länge
`updated_at` står still — en ny inbäddning hade gjort alla ogiltiga.
`update_updated_at()` flyttar nu bara när innehåll, metadata eller nivå ändras.

På en testdatabas tog bytet till bge-m3 några sekunder och varje minne gick att
hitta efteråt, men jämförelsen visade också varför rutan varnar för
gränsvärdena: bge-m3 ger ett orelaterat minne runt 0,40 där
text-embedding-3-small ger 0,30, så gränserna för sökning, hook, dubbletter och
motsägelser — alla uppmätta med text-embedding-3-small — skulle behöva mätas om
efter ett byte.

---

## 2026-10-14 — 0.10.1: en domare som inte larmar i onödan

Motsägelsekontrollen i 0.10.0 frågade metadatamodellen, gpt-4o-mini, och mot det
riktiga minnet kallade den 14 av sina första 20 par för motsägelser. Nästan alla
var fel: att `cc/` går till Claude och `cx/` till Codex var "en konflikt", och
det var även två maskiner med två olika sökvägar. En sådan lista lär läsaren att
strunta i den.

Paren den flaggade blev testmängden, med tre planterade motsägelser bredvid (en
port, en preferens, en lagringstid). En striktare prompt — samma sak, samma
egenskap, två värden; olika saker, saknad information och specialfall är alltid
förenliga; vid tvekan, förenliga — lämnade ändå gpt-4o-mini med nio falsklarm.
Qwen3-235B och DeepSeek V3.2, båda med öppna vikter, larmade inte en enda gång
och hittade alla tre planterade. Qwen är den billigare av de två, ungefär en
hundradels cent per par, och är nu standard som `CONTRADICTION_MODEL`; en annan
endpoint än OpenRouter faller tillbaka på `META_MODEL`.

Utlåtanden minns vilken modell som gav dem. Ett från en tidigare modell varken
visas eller behålls: nattkörningen bedömer paret igen, så utlåtandena från
0.10.0 byts ut utan att någon rör databasen för hand. Läsarens *Ingen
motsägelse* sparas under modellen `user` och överlever ett modellbyte.

---

## 2026-10-14 — 0.10.0: tre idéer från OB1

Mimers Brain utgick från [OB1](https://github.com/NateBJones-Projects/OB1), och
OB1 har fortsatt att växa. Det mesta som kommit till sedan finns redan här i en
annan form — dubblettstopp med fingeravtryck, hybridsökning, typade relationer,
proveniens, en kvalitetsgranskning. Tre saker fanns inte, och den här versionen
tar in dem.

**Minnena kommer till frågan.** Den stående regeln säger att man ska söka innan
man agerar, och modellerna följer den ojämnt: den 2026-08-06 felsöktes ett
ESPHome-bygge i nittio minuter medan svaret låg i minnet. OB1:s recept *live
retrieval* angriper det från andra hållet, och det gör även
`tools/hooks/mimer-recall.py` — en `UserPromptSubmit`-hook för Claude Code som
söker en gång på varje fråga och lägger till upp till tre minnen i modellens
kontext. Serversidan är `POST /api/recall-hint`. Den använder ett semantiskt golv
på 0,5 i stället för sökningens 0,3, uppmätt mot det riktiga minnet:
ESPHome-regeln fick 0,54 mot en verklig byggfråga, medan orelaterade frågor
stannade på högst 0,49. Den skapar inget recall-kvitto, eftersom modellen aldrig
frågade, sparar ingen fråga, och vägrar att bädda in en fråga som
hemlighetsspärren skulle vägra att spara.

**Varje ändring loggas, och en radering kan ångras.** OB1:s schema *thought
audit*, gjort som en trigger så att den även ser det som aldrig går genom
servern: en psql-session, ett skript, loopen med fel filter som tömde databasen
2026-08-04. `thought_changes` sparar skapande, ändring och radering med
skribentens namn och fälten som de var före. Namnet når triggern som en
transaktionslokal inställning: varje anrop körs under sin klients namn, och en
skrivning utan namn loggas som `sql:<roll>`. En ändring i webbgränssnittet skrev
förut över den gamla texten för gott; varje kort har nu listan **Ändringar** med
*Återställ den här versionen*. Ett raderat minne behåller sin text, relationerna
inräknade, i 30 dagar (`CHANGE_LOG_DELETED_DAYS`) och kan återställas från sidan
Granska under sitt eget id, eller glömmas direkt med *Glöm nu*.

**Motsägelser letas upp.** Granskningen prövar varje minne för sig och
dubblettlistan hittar två som säger samma sak; inget märkte två som säger olika
saker om samma ämne. Det gör OB1:s *lint sweep*. Här läses varje par av
aktuella minnen med en likhet på 0,6 eller mer av metadatamodellen, de mest lika
först, och den avgör om båda kan vara sanna nu. Första utkastet stannade vid
0,86, där dubblettlistan börjar; en testdatabas visade varför det var fel — den
tydligaste motsägelsen, samma server på port 8790 i ett minne och på 8795 i det
andra, fick 0,87. Tjugo par per natt, eller på begäran från sidan Granska; ett
utlåtande gäller tills något av minnena ändras, så inget par betalas två gånger.
Motsägelser visas med samma val som dubbletter, plus *Ingen motsägelse*. Inget
ändras automatiskt.

Två mindre ändringar följde med. Databastesterna bygger nu en egen databas från
`db/init.sql`, så att de kan köras sida vid sida och om igen utan städning
(`server/testing/db.mjs` beskriver hur). `test-isolation.ps1` kontrollerar att den
öppna lyssnaren inte ser någon valvrad genom ändringsloggen eller recall-hinten,
och städar bort sina kanariefåglar ur ändringsloggen efteråt.

---

## 2026-10-14 — 0.9.32: ett nytt minne får namnge sig själv

`capture_thought` tar emot samma valfria `title` som `supersede_thought` fick i
0.9.31: högst 100 tecken, ersätter bara den extraherade titeln och prövas
fortfarande mot `describesContent()`. Svaret anger titeln som sparades.

---

## 2026-10-14 — 0.9.31: en ersättning får behålla sin titel

När en detalj i ett minne rättades med `supersede_thought` bytte minnet också
namn: verktyget tog bara emot texten, och metadatamodellen skrev en helt ny
titel. Ett minne med titeln "OmniRoute-LXC:n (10.0.0.42): CLI:t och tjänsten
måste dela samma .env" kom tillbaka som "Felsökning av omniroute-CLI och
systemd-tjänst" — vagare, och inte längre namnet en läsare letade efter.

Inget krävde det. Agenter skickar bara text för att servern, aldrig den som
anropar, ska bestämma förtroendet, men en titel är inget förtroendefält — och
webbens eget `POST /api/thoughts/supersede` tar redan emot hela metadatan.
MCP- och OpenAPI-verktygen visade bara aldrig fältet.

`supersede_thought` tar nu emot en valfri `title` på högst 100 tecken. Den
ersätter bara den extraherade titeln och prövas fortfarande mot
`describesContent()`, så en titel som hör till ett annat minne ersätts av en
härledd. Svaret anger titeln som sparades, så att anroparen ser när det hände.

---

## 2026-10-14 — 0.9.30: fyra granskningsval, inte fem

Sidan Granska hade Begränsa bredvid Endast evidens, och ingen kunde säga vad
som skilde dem åt. Begränsa skrev `can_use_as_evidence=false`, men sökningen
läste aldrig den flaggan, så ett begränsat minne hittades, rankades och
märktes precis som ett minne med endast evidens. Att låta knappen dölja minnet
i sökningen hade inte hjälpt heller: Avvisa gör redan det, och arkiverar i
stället för att radera, så Begränsa hade blivit Avvisa under ett annat namn.

Begränsa är borttagen från sidan Granska, från `review_memory` och från
HTTP-API:t. De fyra val som är kvar gör var sin sak som de andra inte gör:

- **Bekräfta** — minnet blir en regel som agenten får följa som Eriks egen.
- **Endast evidens** — en ledtråd att kontrollera, aldrig en instruktion.
- **Markera gammalt** — endast evidens, och tillbaka i granskningskön för att
  uppdateras.
- **Avvisa** — arkiveras och försvinner ur sökningen.

Minnen som begränsats tidigare behåller sina flaggor, fungerar fortfarande som
endast evidens och räknas fortfarande som begränsade på statistiksidan. Ett
test fallerar nu om knappen kommer tillbaka.

## 2026-10-13 — 0.9.29: titlar som beskriver, sammanfattningar som tar slut

En granskning av alla 287 aktuella minnen hittade 69 med en titel eller
sammanfattning som var avklippt mitt i ett ord, kopierad från textens början
eller saknades, och 151 svenska minnen med engelsk sammanfattning. Fyra orsaker,
alla rättade:

- Metadatamodellen fick aldrig veta vilket språk den skulle skriva på, så svensk
  text fick engelska titlar och sammanfattningar. Prompten säger nu "samma språk
  som texten", ber om en kort beskrivande titel på högst 100 tecken och en
  sammanfattning i en till tre hela meningar, och förbjuder att texten kopieras
  eller klipps — "högst 180/500 tecken" hade bjudit in till just det.
- När modellens metadata underkändes tog reservvägen de första 180 eller 500
  tecknen rakt av. `shorten()` stannar nu vid en meningsgräns eller ett helt ord
  och lägger till en ellips.
- Förankringskontrollen läste skiljetecken direkt efter en sökväg som en del av
  sökvägen ("...\README.md." hittades inte i texten), så korrekta
  sammanfattningar kastades tyst och ersattes av reservvägen. Avslutande `.`,
  `:` och `-` tas nu bort från sökvägsankare.
- 33 minnen som importerats från det gamla systemet hade aldrig fått titel eller
  sammanfattning.

`npm run audit` rapporterar nu `title-looks-cut` och `summary-looks-cut`. De 69
trasiga minnena och de 151 (plus ett som granskningen missade) engelska
sammanfattningarna skrevs om för hand på textens eget språk och kontrollerades
mot förankringsregeln innan de sparades; granskningen hittar nu inga. En fälla
finns kvar med avsikt: en titel tappar allt från ordet "ersätter" eller
"kompletterar" och framåt, en regel för äldre ersättningsprosa — formulera om
hellre än att slåss mot den.

---

## 2026-10-13 — 0.9.28: en policy som kommer fram hel

Regel 15 sa åt varje modell att anropa `memory_digest` när sessionen startar,
och Claude Code såg den aldrig: den klipper MCP-serverinstruktioner vid 2048
tecken, och policyn plus anslutningsraden var 3423. Allt efter mitten av regel
10 försvann — regeln om startpaketet, regeln om hemligheter, ersättning och
kvittoreglerna. Upptäckt genom att läsa vad just den här sessionen hade fått,
som slutade med `… [truncated]`.

Klienterna får nu en kort form när de ansluter (ungefär 800 tecken på alla
lyssnare, testad att hålla sig under 2048) där första raden säger åt dem att
anropa `memory_digest`; startpaketet börjar med hela policyn och
anslutningsraden före de fasta minnena, och OpenAPI-versionen ger `policy` och
`scope` bredvid posterna. Själva policyn gick från fjorton regler och 3193 tecken
till tio och 2250: inget togs bort, regler som sa samma sak två gånger slogs
ihop. Sidan Anslut erbjuder fortfarande hela texten för klienter som ignorerar
serverinstruktioner.

---

## 2026-10-13 — 0.9.27: vad som finns i startpaketet

Startpaketet saknade en egen vy: enda sättet att se vad varje modell fick var
att öppna minnena ett i taget. Sidomenyn på sidan Tankar börjar nu med filtret
**Startpaket** och dess antal. Filtret, antalet, 📌-märket och själva
`memory_digest` delar ett och samma SQL-villkor (`DIGEST_SQL`), så de kan inte
säga olika saker. Arbetet med vyn visade en lucka: ett minne som var fäst men
inte bekräftat bar märket fast startpaketet hoppade över det. Nu står det
**startpaket: väntar på bekräftelse** i stället.

---

## 2026-10-13 — 0.9.26: hjärnan, och fyra idéer från Synapse

**Hjärnan.** Sidan Statistik börjar nu med en 3D-bild av hela minnet: varje
aktuellt minne en lysande punkt i en hjärna av trådnät. Två minnen är kopplade
när de delar sort, uppgiftsstatus, projekt, ämne, person eller system, eller
när de betyder nästan samma sak (cosinus 0,60 eller mer — uppmätt: 0,50 kopplade
allt till allt, 0,70 lämnade de flesta minnen ensamma). Varje typ av koppling
har en egen linjefärg och en knapp. Minnet med flest kopplingar är störst och
sitter längst in; var ett minne hamnar följer dess betydelse, från
inbäddningarnas tre huvudaxlar (`server/semantic.mjs`), så närliggande minnen
delar ett område som namnges efter det ämne, system eller projekt som är mest
typiskt för det. Dra på tom yta för att vrida, scrolla eller nyp för att zooma,
ta tag i ett minne för att dra ut dess linjer; det fjädrar tillbaka när man
släpper. Grannarna rör sig bara lite — en tidig version lät dem följa med, och
med alla kopplingstyper på når ett minne större delen av hjärnan, så allt rörde
sig som ett block. Markeringen vid hovring tonas in på tre kvarts sekund; först
tändes den direkt och hjärnan blixtrade när muspekaren gick över en tät del.
Inget bibliotek: en 2D-canvas som matas från `/api/graph`.

Sedan fyra idéer hämtade från [Synapse](https://github.com/Danialsamadi/synapse)
(bara idéer; dess kod är GPL-3.0):

- **En spärr mot hemligheter.** "Spara aldrig råa hemligheter" fanns bara i
  verktygsbeskrivningarna och höll alltså precis så bra som modellen som läste
  dem; mönsterkollen i `memory-quality.mjs` kördes bara i granskningsskriptet.
  Varje väg som sparar stoppar nu text som ser ut som en privat nyckel,
  API-nyckel, token, JWT, lösenord i en URL eller `password: ...` innan den når
  metadatamodellen, inbäddningen eller databasen, med 422 som bara anger typen.
  Platshållare, namn på miljövariabler och SECRET_REF-pekare går igenom. Körd
  mot alla 579 rader först: inga träffar.
- **Kvitton som räknas.** Kvitton om använt/ignorerat samlades in men lästes
  aldrig tillbaka. Nu knuffar de rankningen några hundradelar, centrerat på den
  genomsnittliga användningen (ungefär var fjärde träff används, eftersom en
  sökning ger fem), och minnen som hittats åtta gånger eller fler men aldrig
  använts listas på sidan Granska. Att bekräfta ett nollställer räkningen.
- **Ålder i svaren.** En träff som inte verifierats på 180 dagar säger det
  (`AGE: Verified 8 months ago ...`). Inte för incidenter eller historik.
- **Startpaketet.** Bara Claude Code läser en `CLAUDE.md`; DeepSeek, en
  OmniRoute-modell eller en mobilapp började utan att veta något tills de råkade
  söka på rätt sak. `memory_digest`, på alla lyssnare, ger de bekräftade
  preferenserna och profilminnena plus allt som fästs på sidan Tankar, och
  policyregel 15 säger åt varje klient att anropa det en gång. Bara läsaren kan
  fästa — agenter kan inte sätta fältet — och bara bekräftade minnen visas.

---

## 2026-10-06 — 0.9.25: när ett minne skrevs

Listan **Tankar** visade bara datumet då ett minne skapades, och sidan
**Granska** visade inget datum alls, så ett väntande minne eller ett
dubblettpar sa inget om hur gammalt det var. Båda visar nu när minnet skapades
som `2026-10-06 - 20:54` i lokal tid, likadant på alla språk.
Dubblettfrågan returnerade inte `created_at` för någon sida av paret; nu
returnerar den `left_created_at` och `right_created_at`.

---

## 2026-09-18 — 0.9.24: ett saknat kvitto är inget fel

Två dagar efter 0.9.23 sa TokenTrackern `CHECK` igen. Den här gången räknade
räknarna rätt: en Claude Code-session hade sökt i minnet kvällen innan och
stängts utan att lämna sitt användningskvitto. Det är vardag — en harness som
avslutas i förtid kan inte rapportera — och inget någon behöver gå bort och
kolla. Ett enskilt orapporterat spår syns fortfarande i
`sensor.mimers_brain_recall_unreported`, men statusen förblir nu `ok` tills
antalet når en gräns, för många saknade kvitton på ett dygn betyder en klient
som aldrig rapporterar, och det är värt en titt.

Gränsen är en dragbar i Home Assistant, `number.mimers_brain_unreported_fault`
(1–50), publicerad via MQTT discovery precis som sensorerna. En ändring slår
igenom vid nästa publicering, och valet sparas som ett retained-meddelande på
brokern så att en omstart av hjärnan inte glömmer det. `MQTT_UNREPORTED_FAULT`
i `.env` ger bara startvärdet (5) första gången hjärnan ansluter.

## 2026-09-16 — 0.9.23: en status som kan återhämta sig

TokenTrackerns statussida hade visat `CHECK` för Mimers Brain i veckor medan
minnet självt var helt friskt. Två MQTT-räknare var felet, inte hjärnan.
`memories_unembedded` räknade varje rad utan embedding, även arkiverade
ingest-källor som avsiktligt aldrig embeddas, så varje import av lång text gav
ett permanent fel. Nu räknas bara aktuella, ej avvisade minnen — samma
definition som statistiksidan redan använde. `recall_unreported` räknade varje
orapporterat spår sedan tidernas begynnelse, och eftersom en kraschad harness
aldrig lämnar sitt kvitto kunde talet bara växa: en död session i augusti hade
hållit displayen gul tills tvåårsgallringen tog bort den. Räknaren tittar nu på
ett rullande dygn, länge nog att agera på ett saknat kvitto och kort nog att
statusen läker av sig själv. Statistiksidan visar fortfarande hela historiken.

## 2026-09-02 — 0.9.22: en person, en användbar titel

Personfacetten visade `Louise` och `Louise Sjogren` som skilda människor trots
att den aktuella metadatapolicyn redan namnger Eriks dotter enbart som `Louise`.
Både den fullständiga svenska stavningen och ASCII-formen översätts nu till det
kanoniska namnet vid varje skrivning. Normaliseringsauditen kan därför rätta de
två historiska rader som skrevs före regeln utan att ändra deras livscykel eller
granskningshistorik.

Tre i övrigt användbara aktuella minnen bar fortfarande extraktorns reservtitel
`Untitled memory`. Den behandlas nu som saknad metadata, så normaliseraren
härleder en riktig titel ur innehållet. Det är både ett beständigt skrivskydd och
en städning av befintliga rader.

## 2026-08-29 — 0.9.21: ett system, en stavning

Isoleringssviten gick inte att köra mot det riktiga minnet alls: `/api/stats`
svarade med `Docker` och `docker` som skilda nycklar, och en klient vars
objektmodell är skiftesokänslig — PowerShells är det — kan inte tolka det som ett
objekt. Åtta system hade glidit isär i två stavningar var: `Docker`/`docker`,
`ESPHome`/`ESPhome`, `Node-RED`/`node-red`, `Tokentracker`/`TokenTracker`,
`DeepSeek Harness`/`Deepseek Harness`, `Node`/`node`, `bash`/`Bash` och
`python-collector`/`Python-collector`.

Auditkörningen rapporterade ingenting, och det var riktigt: system dubblettrensas
inom ett minne, men ingenting avgjorde stavningen mellan minnen. De är fri text
med flit — ett system kan vara vilken maskin, tjänst eller skript som helst — så
en sluten ordlista av det slag topics har hade varit fel. `canonicalSystem` rättar
bara stavningen, nyckeln är gemener, och bara för namn minnet redan använder. Ett
okänt system passerar precis som det skrevs.

Statistikfrågan är den varaktiga halvan av fixen. Personer och system grupperas nu
på gemener, och den vanligaste stavningen namnger gruppen, så ett nytt fritextnamn
som dyker upp i två skepnader räknas en gång och visas en gång i stället för att
dela sin egen summa. Topics och projekt behöver inget av detta: ett topic kommer
från en sluten ordlista i gemener, och ett projekt är en enda sträng.

## 2026-08-29 — 0.9.20: en port som bara kan läsa

Mindre kapabla modeller sköter sällan ett minne. De sparar det som redan står i
repot, skriver ner sitt eget resonemang och ersätter aldrig posten de just
motsagt. Att be dem sköta sig fungerar inte, så en tredje lyssnare svarar på
port 8792 och registrerar helt enkelt aldrig ett verktyg som skriver: inget
`capture_thought`, `preview_ingest`, `apply_ingest`, `review_memory`,
`supersede_thought` eller `delete_thought`, varken över MCP eller OpenAPI. Kvar
finns sökning, listning, hämtning och statistik, plus `report_memory_usage`, som
skriver ett återkallningskvitto och inte ett minne, och som varje sökning ber om.
Anslutningsbeskrivningen säger rakt ut till modellen att den inte kan minnas
något, så den ber användaren spara i stället för att lova att den gör det.

Det är samma resonemang som nivåuppdelningen redan vilar på: skrivning är en
förmåga hos lyssnaren, inte en egenskap hos anropet, så det finns inget att
övertala servern till. Porten serverar `/mcp`, `/openapi.json` och `/tools/*` och
ingenting annat — inget webbgränssnitt och ingen dashboard-REST, eftersom båda
skriver.

`MCP_READ_KEY` är en tredje nyckel med flit. Ger man en läsande klient den öppna
nyckeln kan den skriva på 8791 med samma sträng, vilket är precis det som ska
förhindras. Lämnad tom faller porten tillbaka på `MCP_ACCESS_KEY`, vilket
fungerar men inte går att rotera för sig. Anslut-sidan fyller i adressen och
nyckeln som för vilken annan klient som helst.

Isoleringssviten växte från 48 kontroller till 78. De nya slår fast en frånvaro:
ingen av ytorna erbjuder ett skrivverktyg, `capture_thought`,
`supersede_thought` och `delete_thought` nekas även när valvnyckeln visas upp,
inget av det försöken skickade når minnet, porten svarar fortfarande på en
sökning, och läsnyckeln öppnar 8792 men ingen av de andra två. Canary-raderna
listas i stället för att sökas, eftersom en rad sparad utan embedding hade varit
osynlig för en semantisk sökning och kontrollen hade gått igenom av fel skäl.

Varje `Invoke-WebRequest` i sviten skickar nu `-UseBasicParsing`. Utan den
lämnar Windows PowerShell 5.1 svaret till Internet Explorers motor och kastar ett
naket "Object reference not set to an instance of an object" på en maskin där IE
aldrig satts upp — ett fel som inte säger något alls om servern som testades.

## 2026-08-24 — 0.9.19: skiljetecken är inte en identifierare

Live-torrkörningen av 0.9.18 fångade ett falsklarm innan någon metadata skrevs:
vanliga uttryck som `Home Assistant:s`, `API:er` och `pickup/drop` kunde tolkas
som en främmande teknisk identifierare. Grundningsvakten begränsar nu den hårda
avvisningen till starkare signaler: identifierare med underscore, numeriska
eller flerpunktade versioner och sökvägar med flera segment. Ett regressionstest
håller vanlig svensk och engelsk interpunktion borta från identifierarvägen.

## 2026-08-24 — 0.9.18: Minnet är inte projekthistorik

Den centrala policyn och Desktop Commanders beständiga instruktioner ger nu små
modeller en smal skrivgrind: en aktuell, verifierad kunskapsbit som kan ändra ett
framtida svar. Statusrapporter, färdigt arbete, tester, releaser, versioner,
commits och sessionssammanfattningar hör hemma i README och
historik/changelog. Saknar projektet någon av filerna föreslår modellen att
skapa den i stället för att falla tillbaka på Mimers Brain. `task` är reserverat
för uttryckligen oavslutat arbete med ett konkret nästa steg, medan
`user_confirmed` betyder att användaren bekräftat den exakta minnestexten — att
godkänna arbetet, avsluta eller säga fortsätt räcker inte.

Gränsen för atomär ingest är nu 1200 tecken och gäller likadant för capture och
`supersede_thought`, inklusive MCP, OpenAPI och webbredigeraren.
Metadataextraktionen definierar varje kind och behandlar `project` som repot
eller tjänsten som äger kunskapen, inte klienten eller harnesset. En
deterministisk metadatavakt avvisar också översatta titlar eller sammanfattningar
som introducerar en teknisk identifierare som saknas i innehållet.

`npm run audit` är fortsatt skrivskyddad och rapporterar nu UUID-baserade
kvalitetsvarningar för för stora eller mångsyftande aktuella poster, avslutade
uppgifter, sessionshistoriskt språk, möjliga hemlighetsfragment, ogrundad
metadata och skillnader mellan projekt och sökväg. Den skriver aldrig ut
minnesinnehåll eller hemliga värden.

## 2026-08-20 — 0.9.17: ordförrådet måste finnas kvar på slutet

0.9.13 utnämnde `other` till sista utväg i stället för det tjugosjätte likvärdiga
alternativet, och det höll — på korta minnen. Två svenska minnen om Mimers Brain
självt, ungefär 4500 tecken vardera, sparades 2026-08-20 med topics `["other"]`
medan `project` stod rätt som `mimers-brain`. Ämnet var aldrig oklart. Den
slutna listan hade helt enkelt rullat tusentals tecken bort när svaret skrevs.

`supersede_thought` är den enda skrivvägen utan längdspärr. Capture vägrar allt
från 1500 tecken och uppåt och skickar det genom `preview_ingest`, som ger korta
atomer, så supersede är enda sättet en text i den storleken når extraktionen hel.
Det är därför rättningen såg felfri ut överallt där den provades.

Texten ligger nu i ett avgränsat block, så lång prosa kan inte läsas som
instruktioner, och den slutna listan och meningen om sista utväg upprepas efter
den, intill beslutet. En ny rad täpper till gapet som de två raderna föll genom:
när `project` namnger ett ämne som står på listan hör det ämnet hemma i `topics`.

Mätt mot de två riktiga raderna på liveservern, sexton körningar per prompt: den
gamla formen fick med `mimers-brain` fyra gånger och svarade blankt `["other"]`
fem gånger, med `node-red` och `powershell` bland missarna. Den nya formen fick
rätt sexton gånger av sexton och grep aldrig efter `other`.

## 2026-08-20 — 0.9.16: säg vad det kostar innan det kostar

En rullgardin som tyst raderar rader är en fälla, hur bra etiketten än låter. Att
korta gallringstiden gallrar direkt — det var meningen — men sidan sa ingenting
om vad som var på väg att försvinna, och telemetrin ligger inte i backupvägen på
samma sätt som minnena gör.

Att ändra tiden frågar nu servern vad ändringen skulle kosta, och säger det rakt
ut: hur många användningshändelser och återkallningskvitton som är äldre än det
nya fönstret, att de försvinner permanent, och att statistiken för den perioden
går med dem. Avbryter man ställs rullgardinen tillbaka. Ett kortare fönster som
inte tar bort något frågar ingenting. En fast rad under väljaren säger vad som
över huvud taget berörs — användningsloggen och kvittona, aldrig ett minne.

Endpointen bär samma uppdelning: `POST /api/usage/retention` utan `apply: true`
räknar bara, och skriver aldrig.

## 2026-08-20 — 0.9.15: kvittologgen läses, den granskas inte

Rullgardinen för gallringstid i 0.9.14 svarade på en fråga ingen hade ställt. Det
som efterfrågades var att göra kvittotabellen på sidan Granska kortare att läsa,
inte att radera rader ur databasen. Två olika saker, och bara den ena går att
ångra.

Kvittolistan har nu en egen `Visa`-väljare — 10, 25, 50, 100 eller 200 rader,
ihågkommen per webbläsare i `localStorage` och skickad till `/api/review` som en
frågeparameter. Standardvärdet går från 50 till 25. Ingenting raderas; loggen
läses nyast först, och hur långt bak den räcker är ett läsval.

Rullgardinen för gallring från 0.9.14 ligger kvar där den är. Den svarar på den
andra frågan — hur länge raderna lever — och den hör hemma på sidan Statistik
bredvid meningen som redan förklarade den.

## 2026-08-20 — 0.9.14: vem som skrev det, och hur länge kvittona ligger kvar

Tre små saker som en hjärna med flera skrivare behöver.

Sidan Tankar laddade inte om när man kom tillbaka till den. Granska och Statistik
ritas om vid varje besök; Tankar bytte bara en CSS-klass, så ett minne du just
bekräftat bar kvar sin `pending`-etikett tills sidan laddades om för hand. Den
anropar nu `refresh()`, som kör om den aktuella frågan — söktexten och filtren
överlever resan.

Ett minne sa `origin: agent` och inget mer. Det räcker när en agent skriver till
hjärnan, och säger ingenting när Claude Code, Codex och en tredje harness skriver
till samma. `captured_by` registrerar nu klienten från MCP-handskakningen, och
granskningskön visar den. Värdet tas ur den autentiserade handskakningen och
rensas bort ur anroparens egen metadata av samma skäl som tillitsfälten: en agent
ska inte kunna döpa sig till något annat. Handskakningen känner *programmet*,
aldrig modellen, vilket är den ärliga gränsen här — `claude-code`, inte `opus-5`.
Bara nya minnen bär fältet.

Gallringstiden var en miljövariabel och en omstart. Nu är den en rullgardin på
sidan Statistik, sparad i `app_settings`, med `USAGE_RETENTION_DAYS` nedflyttad
till det värde en hjärna startar med. Att korta tiden gallrar direkt i stället
för att vänta på morgondagens dagliga pass, och `Spara allt` stänger av
gallringen helt. Bara den fulla lyssnaren får ställa den: den öppna lyssnaren ser
inte raderna som regeln gäller.

En fråga som ställdes den här sessionen och medvetet inte åtgärdades: en harness
som kraschar mitt i ett svar lämnar sitt återkallningskvitto orapporterat för
alltid. Det är rätt utfall. Spåret är en logg över vad som påverkade ett svar,
och en rapport som återskapas i efterhand ur ett förlorat spår-ID vore en gissning
nedskriven som ett faktum. Ett orapporterat kvitto kostar ingenting och åldras nu
ut med resten.

## 2026-08-19 — 0.9.13: extraheringen kan bara återanvända det den ser

Att filtrera på projekt missade minnen som uppenbart handlade om projektet. Tio
Glance Clock-minnen låg under tre andra stavningar än `glance-clock`, och samma
glidning hade gett `token-tracker`, `photo-frame`, `server-inventarium` och fyra
namn med `snille/`-prefix. Arton rader, och varje projektfilter var tyst
ofullständigt.

`topics` glider aldrig på det sättet, eftersom den har en sluten ordlista och ett
felaktigt värde inte kan nå databasen. `project` är fritt med flit: ett verkligt
nytt projekt måste kunna döpa sig självt. Men modellen döpte projekt utan att få
se dem som redan fanns, så ett nytt namn blev standardutfallet i stället för ett
val. `extractMetadata` listar nu de befintliga projektnamnen, sorterade efter hur
vanliga de är, och säger att ett nytt namn är till för när inget av dem äger
texten. Uppslaget cachas i fem minuter eftersom det ligger i sparvägen, och ett
misslyckat uppslag faller tillbaka till den enkla raden så att en sparning aldrig
blockeras av det.

Beviset kom före fixen. Ett minne som skrevs mitt under städningen hamnade under
projektet `docker` — ett ämnesord, inte ett projekt. Det är regeln som prompten
nu säger rakt ut.

`other` hade motsatt problem: en sluten ordlista som erbjöd den som ett av
tjugosex likvärdiga val, så modellen tog den när den tvekade. Den hade spridit
sig till 158 av 290 minnen, och 98 av dem bar ingenting annat, vilket ställer ett
minne utom räckhåll för varje ämnesfilter. Ytterligare sextio bar `other` bredvid
ett ämne som redan passade. Listan erbjuder nu de tjugofem riktiga ämnena, och en
egen mening pekar ut `other` som sista utväg — aldrig bredvid ett värde som
passar.

Databasen städades i samma veva: 148 rader ometiketterade, 18 omdöpta, fem
felplacerade projekt rättade. `npm run audit` rapporterar noll. Tio minnen
behåller `other` med flit — favoritfärg, familj, bostadsort, arbetsgivare —
eftersom ordlistan saknar personligt ämne och att tvinga in ett hade gjort
sökningen sämre.

En sluten ordlista stoppar felaktiga värden. Den stoppar inte ett lättjefullt
värde, och den säger ingenting alls om facetten bredvid.

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

## 2026-08-17 — 0.9.12: Erik har ett namn

People-facetten listade `Erik` och `Erik Pettersson` som olika människor, och
`Snille` som en tredje sak. Allt är Erik, vilket gjorde det meningslöst att
filtrera på person. De tre översätts nu till `Erik`, liksom YouTube-handtaget
`MrSnille`. Fullständiga namnet och handtagen står kvar i minnestexten, så inget
går förlorat av att indexeras under ett namn.

`Snille` behövde en åtskillnad snarare än en regel: det är ett handtag, ett
GitHub-konto och en del av sökvägar som `Snille/glance_clock_ha`. Facetten
avgör. I `people` betyder det människan och blir Erik; i `systems` betyder det
kontot och lämnas i fred. Tidigare flyttades det från people till systems,
vilket dolde att det är han.

## 2026-08-17 — 0.9.11: en ersättare ärver förtroendet den ersätter

`supersede_thought` skickade `userConfirmed: true` villkorslöst, på både
MCP-ytan och OpenAPI-ytan. Att skriva om ett minne som låg som pending och
evidence-only befordrade det därför till en användarbekräftad instruktion som
användaren aldrig läst, och tog bort det ur granskningskön i samma skrivning.
Erik märkte att kön var tom och frågade varför.

Förtroendet ärvs nu: en ersättare är bekräftad bara när varje minne den ersätter
var bekräftat och fick användas som instruktion. En svag källa räcker för att
hålla ersättaren pending. Båda ytorna har fått en uttrycklig `user_confirmed`, för
fallet då användaren verkligen godkänt just den texten, och båda rapporterar nu
den resulterande granskningsstatusen så att anroparen inte behöver gissa.

Minnen som skrevs före ändringen behåller sin bekräftade status enligt Eriks
beslut, eftersom han godkände den städningen steg för steg. Regeln gäller framåt.

Samma form som revisionsfelet i 0.9.6: en skrivväg som tyst delar ut
instruktionsrätt. Värt att granska varje annat ställe som sätter förtroende utan
att bli tillsagt.

## 2026-08-17 — 0.9.10: ett omatchat ankare är inget bevis

En kort titel bär för lite text för att språket ska kunna avgöras, så
`Erik's server inventory at 10.0.0.x` på ett svenskt minne bedömdes på det enda
ankaret `inventory` och avvisades — till förmån för en härledd titel som var
uppenbart sämre. Ett avslag kräver nu minst två ankare, varav inget finns i
minnet. Det ursprungliga felet faller fortfarande, eftersom
`Mäta och optimera Wi-Fi-nätverket hemma` bär `optimera` och `nätverket`.

## 2026-08-17 — 0.9.9: avgör språket innan ämnet bedöms

Ankare bär en översättning mellan språk bara när minnet råkar nämna en produkt
eller en sökväg. En korrekt engelsk sammanfattning av ett svenskt minne som inte
nämner någon av dem såg fortfarande främmande ut, och det var precis vad de
återstående revisionsfynden visade sig vara. Kontrollen avgör nu språket hos
förslaget och hos innehållet med hjälp av funktionsord och svenska diakriter, och
står tillbaka när de skiljer sig. Samma språk, samma ämne: en svensk
sammanfattning om Wi-Fi-täckning på ett svenskt minne om people-facetten avvisas
fortfarande.

Detta är tredje rättelsen av samma vakt på en dag, och varje enskild hittades av
att köra revisionen mot verklig data — inte av att resonera om koden. Det är
argumentet för att ha en revision som rapporterar noll när den ska.

## 2026-08-17 — 0.9.8: bindestreck delades bara på ena sidan

Ankarkontrollen behöll sammansättningar med bindestreck hela, medan innehållet
delades vid bindestrecken. `ESPHome-setup` kunde därför aldrig matcha ett minne
som säger `ESPHome-miljö`. Elva titlar flaggades av just det skälet.
Sammansättningar bedöms fortfarande hela när det avgörs vad som är ett ankare —
`ESPHome-setup` är ett namn — men matchas i delar, och delar kortare än tre
tecken kastas så att `Wi-Fi` inte kan matcha på `wi`. Delsträngsjämförelsen är
borta med dem; ett ankare matchar nu ett helt innehållsord eller inget alls.

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
