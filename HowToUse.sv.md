# Så använder du Mimers Brain

*[English](HowToUse.md)*

Hur du kopplar en AI-modell till minnet, och hur du sätter upp allt igen om en
maskin behöver installeras om.

> **Webbgränssnittet gör det här åt dig.** Öppna minnet i en webbläsare och gå
> till **Anslut**: samma anvisningar som nedan, fast återgivna med den körande
> instansens egna adresser, nycklar och verktygslista, med kopieringsknappar. Det
> här dokumentet förklarar *varför* varje inställning ser ut som den gör, och
> täcker det en sida inte kan — att bygga om servern, reverse proxyn, en
> ominstallerad laptop. Börja med sidan; kom hit när något inte beter sig.

---

## Vad det är, kort

Mimers Brain är en **MCP-server** (Model Context Protocol) — ett standardiserat
sätt för en språkmodell att anropa verktyg. Den exponerar sex verktyg:

| Verktyg | Vad det gör |
| --- | --- |
| `search_thoughts` | Sök på betydelse, inte ord. Det här är det viktiga. |
| `list_thoughts` | Lista senaste, med filter på typ, ämne, person, tid |
| `capture_thought` | Spara ett nytt minne |
| `thought_stats` | Totaler, typer, ämnen, personer |
| `search` + `fetch` | Samma sak i det format ChatGPT och Gemini förväntar sig |
| `delete_thought` | Endast på LAN-porten |

Allt som talar MCP kan alltså använda minnet — du behöver inte bygga något per
modell.

---

## De två adresserna

Det här är den enda detalj som verkligen betyder något:

| Adress | Innehåll | Använd när |
| --- | --- | --- |
| `http://192.0.2.41:8790/mcp` | öppet **+ valvet** | du är hemma eller på VPN |
| `https://brain.example.net/mcp` | **endast öppet** | allt annat, och alla andra modeller |

Valvet — nycklar, lösenord, tokens — serveras bara av den första. Det är inte en
inställning som går att slå på för den andra: MCP-servern på 8791 byggs helt utan
förmågan att nå de raderna, så ingen header, parameter eller sökväg kan lyfta ut
dem. Därför kan du peka vilken extern modell som helst på `brain.example.net` utan
att fundera.

Båda kräver `MCP_ACCESS_KEY` som bearer-token.

### Var nyckeln finns

```bash
ssh valv 'grep ^MCP_ACCESS_KEY= ~/mimers-brain/.env | cut -d= -f2'
```

---

## Koppla in en modell

### Claude Code och Claude Desktop är två olika klienter

Skrivbordsappen rymmer båda, och det är där förvirringen börjar. *Code*-delen av
fönstret är Claude Code; chattdelen är Claude Desktop. De håller sina
MCP-servrar i varsitt register, och ingen av dem ser den andras:

| Klient | Register | Sätts upp via |
| --- | --- | --- |
| Claude Code (*Code*-delen) | `~/.claude.json` | `claude mcp add`, eller redigera filen |
| Claude Desktop (chatten) | kontots connectors, `claude_desktop_config.json` | *Inställningar → Connectors* |

Att minnet svarar i en Code-session säger alltså ingenting om chattsidan, och en
tom connectors-lista är inte ett fel — bara ett register ingen har skrivit i.

### Claude Code

```bash
claude mcp add --transport http mimers-brain http://192.0.2.41:8790/mcp --header "Authorization: Bearer <NYCKEL>"
```

Eller redigera `~/.claude.json` direkt — lägg under `mcpServers` på toppnivå:

```json
"mimers-brain": {
  "type": "http",
  "url": "http://192.0.2.41:8790/mcp",
  "headers": { "Authorization": "Bearer <NYCKEL>" }
}
```

Lägg gärna in **båda** adresserna som två poster (`mimers-brain` och
`mimers-brain-remote`). Då fungerar minnet även när laptopen är utanför hemnätet —
med bara öppen nivå, men det är bättre än inget. Så är det redan uppsatt idag.

Ändringen slår igenom vid nästa session.

### VS Code (Codex)

Editorn öppnar anslutningen själv, från din maskin — så LAN-adressen fungerar och
du får **hela** valvet, `delete_thought` inkluderat. Vilken modell som svarar
spelar ingen roll för räckvidden; en molnmodell flyttar inte var MCP-klienten
körs.

Den påverkar däremot vart *innehållet* tar vägen. Varje valvrad ett verktyg
returnerar läggs i kontexten och skickas till modelleverantören vid nästa tur.
Tudelningen finns för att hålla nycklar borta från tredjepartsmoln, och att peka
en editor på 8790 skickar dem dit i samma stund som en sökning råkar träffa en
valvrad. Värt att avgöra medvetet snarare än att upptäcka i efterhand. Pekar du
den på det publika värdnamnet uppstår aldrig frågan.

```bash
codex mcp add mimers-brain --url http://192.0.2.41:8790/mcp --bearer-token-env-var MIMERS_VALV_KEY
```

Det skriver `[mcp_servers.mimers-brain]` i `~/.codex/config.toml`. Själva nyckeln
hamnar inte i filen — Codex läser den ur den namngivna miljövariabeln vid start,
så sätt den som User-variabel och starta om editorn så att extension-värden ärver
den.

Binären `codex` följer med VS Code-tillägget istället för att ligga i `PATH`; på
Windows finns den under
`~/.vscode/extensions/openai.chatgpt-*/bin/windows-x86_64/codex.exe`. Kontrollera
med `codex mcp list`.

### Claude Desktop (chattsidan)

Fjärranslutna MCP-servrar läggs in under *Inställningar → Connectors*, som en egen
connector. Menyformuleringarna flyttar sig mellan versioner, så gå efter
*connector* och *custom* snarare än en exakt sökväg.

Två begränsningar avgör vad som faktiskt går att göra där:

- URL-fältet tar **endast https**. LAN-adressen är ren http och går alltså inte
  ens att skriva in.
- Anslutningen öppnas från Anthropics infrastruktur, inte från din maskin, så en
  privat adress förblir onåbar även om du ger den ett https-namn.

Vilket betyder att **valvet inte går att nå från chattsidan** — och det är
uppdelningen som håller, inte ett hinder att kringgå. 8790 exponeras aldrig utåt;
den regeln är hela poängen med tudelningen. Det som hör hemma i en connector är
det publika värdnamnet, som ger chatten den öppna nivån.

Dialogen har inget fält för en header heller — bara OAuth Client ID och Secret.
Får den en URL den inte kan autentisera mot faller klienten tillbaka på
OAuth-flödet och misslyckas med ett meddelande om att den inte kunde registrera
sig hos inloggningstjänsten. Nyckeln får därför rida med i URL:en istället:

```
https://brain.example.net/mcp?key=<MCP_OPEN_KEY>
```

`MCP_OPEN_KEY` är en andra nyckel som bara den öppna lyssnaren accepterar, och den
får inte vara samma värde som `MCP_ACCESS_KEY` — se *Inloggning* i
[README.sv.md](README.sv.md) för varför. Sätt den i `.env` och starta om.

**Ligger det en autentiserare framför krävs en sak till.** Klienten frågar efter
OAuth-metadata innan den skickar någon JSON-RPC. Bakom forward-auth svarar de
sökvägarna 302 till inloggningssidan, som svarar 200 — och då bestämmer sig
klienten för att det finns en auktoriseringsserver, försöker registrera sig hos
den, och misslyckas med *couldn't register with the sign-in service*. URL-nyckeln
får aldrig en chans, för anropet den skulle autentiserat blir aldrig av. Proxyn
måste svara 404 där istället; blocket finns i
[docs/nginx-brain.conf](docs/nginx-brain.conf). Kontrollera med:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://brain.example.net/.well-known/oauth-authorization-server
```

404 är rätt. Får du 302 kommer connectorn att misslyckas oavsett vilken nyckel du
ger den. Vill du
hellre ha riktig inloggning än en delad nyckel finns designen för det i
[docs/oidc-connector-plan.md](docs/oidc-connector-plan.md); den kräver en
OIDC-provider, vilket är skälet till att den inte är standard.

Vill du ändå ha valvet i chatten, brygg det lokalt istället för att öppna en port.
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) kör som stdio-server på
din egen maskin och når därför LAN-adressen över ren http och lägger på headern
själv:

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "http://192.0.2.41:8790/mcp",
               "--header", "Authorization: Bearer <NYCKEL>"]
    }
  }
}
```

Filen ligger på Windows i `%APPDATA%\Claude\claude_desktop_config.json`; starta om
appen efteråt. Om en viss version fortfarande läser `mcpServers` därifrån varierar
— dyker servern aldrig upp, håll valvarbetet på Code-sidan och låt chatten ha den
öppna nivån. Den uppdelningen kostar lite, eftersom Code-sidan ändå är där valvet
oftast behövs.

### ChatGPT

ChatGPT läser MCP-servrar som connectors och kräver att servern har verktygen
`search` och `fetch` — de finns just för det. Peka den på
`https://brain.example.net/mcp` med samma bearer-header. Använd **aldrig**
8790-adressen här: den är inte nåbar utifrån, och skulle den bli det vore valvet
exponerat för en tredjepart.

### Gemini och övriga

Samma princip: en fjärransluten MCP-server över HTTP med en bearer-token. Allt som
följer specen fungerar. `search`/`fetch`-paret finns för klienter som förväntar sig
den enklare sök-och-hämta-modellen istället för de namngivna verktygen.

### Testa att det gick fram

```bash
curl -s -X POST https://brain.example.net/mcp -H "Authorization: Bearer <NYCKEL>" -H "Content-Type: application/json" -H "Accept: application/json, text/event-stream" -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

Sex verktyg i svaret betyder att allt fungerar. Får du `401` är nyckeln fel; får
du `302` mot `auth.example.net` proxar Nginx `/mcp` genom Authelia, vilket den inte
ska göra — se avsnittet om proxyn nedan.

---

## Webbgränssnittet

| Adress | Vad du ser |
| --- | --- |
| `http://192.0.2.41:8790` | allt, inklusive valvet |
| `https://brain.example.net` | endast öppen nivå, bakom Authelia |

På 8790 loggar du in genom att klistra in `MCP_ACCESS_KEY` en gång; den byts mot
en cookie som ligger kvar i 30 dagar. Utifrån sköter Authelia inloggningen.

När du hovrar över ett minne dyker **Redigera** upp, som öppnar innehållet
tillsammans med typ, ämnen och personer som kommaseparerade fält. Det är så du
rättar det metadata-extraktorn missar — den producerar gärna två stavningar av
samma ämne, eller en persons fullständiga namn i vissa rader och förnamnet i
andra, och de filtrerar som skilda fasetter i sidopanelen. Att slå ihop dem är en
textredigering. Ämnen gemenerseras och dedupliceras vid sparning; personer
behåller sitt skiftläge eftersom de är egennamn.

Att redigera taggar kostar ingenting. Embeddingen räknas på innehållet och räknas
alltså bara om när innehållet självt ändras.

Utöver listan finns **Anslut** och **Statistik** i huvudmenyn. Anslut är
uppkopplingsanvisningarna på den här sidan, fast ifyllda med instansens riktiga
värden. Statistik visar användningen över tid och per klient — men lägg märke
till vad den ärligt kan säga: MCP uppger klientappen, inte vilken modell som
svarar inuti den, och användningsloggen sparar aldrig sökfrågor eller innehåll.
Se README för hur MQTT-sensorerna i Home Assistant hänger ihop med samma siffror.

---

## Om laptopen måste installeras om

Servern på 192.0.2.41 påverkas inte — den är en egen maskin med egen backup. Det
enda som försvinner är klientsidan. Så här får du tillbaka den:

1. **SSH-nyckel.** Skapa en ny och lägg den publika delen i
   `~/.ssh/authorized_keys` för `mimer` på 192.0.2.41. Obs: skapa den via `cmd`,
   inte PowerShell —

   ```powershell
   cmd /c 'ssh-keygen -t ed25519 -C "mimers-brain" -f C:\Users\<du>\.ssh\mimers_valv -N ""'
   ```

   PowerShell gör `-N '""'` till en lösenfras bestående av två citattecken, och
   nyckeln blir oanvändbar obevakat. Lägg sedan till i `~/.ssh/config`:

   ```
   Host valv
       HostName 192.0.2.41
       User mimer
       IdentityFile ~/.ssh/mimers_valv
       StrictHostKeyChecking accept-new
   ```

2. **Hämta nyckeln** enligt kommandot längst upp.

3. **Koppla in MCP** enligt avsnittet ovan.

Det är allt. Kunskapen ligger i databasen på servern, inte på laptopen.

## Om servern måste byggas om

```bash
git clone <detta repo> ~/mimers-brain && cd ~/mimers-brain
cp .env.example .env          # fyll i POSTGRES_PASSWORD, MCP_ACCESS_KEY, OPENROUTER_API_KEY
docker compose up -d --build
```

Sedan återställer du senaste dumpen:

```bash
gunzip -c ~/valv-backups/valv-<senaste>.sql.gz | docker exec -i valv-db psql -U mimer -d valv
```

**Nytt `MCP_ACCESS_KEY` betyder att varje klient måste uppdateras.** Vill du
slippa det, återanvänd den gamla nyckeln från backupen av `.env`.

### Docker i LXC

En oprivilegierad Proxmox-LXC kan inte applicera AppArmor-profiler, och då failar
varje containerstart — ofta maskerat som ett `npm install`-fel mitt i ett bygge.
Lös det på **värden**, inte i containern:

```bash
echo "lxc.apparmor.profile: unconfined" >> /etc/pve/lxc/<vmid>.conf
pct reboot <vmid>
```

`security_opt: apparmor=unconfined` ligger kvar i compose-filen som bälte och
hängslen och är ofarligt även efteråt.

### Reverse proxy

I Nginx Proxy Manager pekar `brain.example.net` på **8791**. Custom-configen måste
ge `/mcp` en egen `location` **utan** `auth_request`, eftersom MCP-klienter inte
kan göra Authelias interaktiva inloggning — skyddet där är bearer-nyckeln. Den
behöver också `proxy_buffering off`, för MCP håller en SSE-ström öppen. Hela
configen finns i `docs/nginx-brain.conf`.

---

## Vad som ska sparas i minnet

Skriv varje minne som ett **fristående påstående** som går att förstå långt senare
utan sammanhang. "Det fungerade" är värdelöst; "deployen av Lagersystem avbryter
om `data/languages/` avviker från origin, eftersom översättningsverktyget skriver
dem live" är användbart.

Lägg i **valvet** om det innehåller en nyckel, ett lösenord eller en token — eller
om det skulle hjälpa någon utomstående att ta sig in. Allt annat är öppet, och
öppet är bättre: det når dig varsomhelst och kan användas av vilken modell som
helst.
