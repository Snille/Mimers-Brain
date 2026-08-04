# Så använder du Mimers Brain

*[English](HowToUse.md)*

Hur du kopplar en AI-modell till minnet, och hur du sätter upp allt igen om en
maskin behöver installeras om.

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

### Claude Desktop

Claude Desktop lägger till fjärranslutna MCP-servrar som **connectors** via
inställningarna: leta efter *Connectors* eller *Anslutningar* och en knapp för att
lägga till en egen. Fyll i URL:en och lägg nyckeln som en `Authorization`-header
med värdet `Bearer <NYCKEL>`.

Menyformuleringarna flyttar sig mellan versioner, så gå efter *connector* och
*custom* snarare än en exakt sökväg. Vissa äldre versioner tar bara stdio-servrar
i `claude_desktop_config.json` och behöver då bryggan
[`mcp-remote`](https://www.npmjs.com/package/mcp-remote) däremellan:

```json
{
  "mcpServers": {
    "mimers-brain": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://brain.example.net/mcp",
               "--header", "Authorization: Bearer <NYCKEL>"]
    }
  }
}
```

Filen ligger på Windows i `%APPDATA%\Claude\claude_desktop_config.json`.

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
