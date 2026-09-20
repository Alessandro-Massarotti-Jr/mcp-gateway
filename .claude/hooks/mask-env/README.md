# Hook `mask-env`

Hook de `PostToolUse` que **permite** a leitura de arquivos `.env`, mas **substitui os valores** antes que o conteúdo chegue ao modelo. Os nomes das variáveis são preservados — o agente continua sabendo o que existe, sem saber o que vale.

```diff
- DATABASE_URL=postgres://admin:s3nh4@db.internal:5432/app
+ DATABASE_URL=<censurado>
```

Ver [../README.md](../README.md) para o panorama dos hooks deste repositório, e a [referência oficial de hooks do Claude Code](https://code.claude.com/docs/en/hooks) para o contrato do runtime.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| [`../../settings.json`](../../settings.json) | Registro do hook (é o arquivo lido pelo Claude Code) |
| [`mask-env.mjs`](mask-env.mjs) | Script Node que faz o mascaramento |
| [`selftest.mjs`](selftest.mjs) | Suíte de testes do script |
| `README.md` | Este documento |

O Claude Code lê a configuração de `.claude/settings.json` (versionado, vale para o projeto inteiro). Esta pasta guarda só o código dos hooks.

---

## Como está registrado

Em `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "hooks": [
          {
            "type": "command",
            "statusMessage": "mask-env",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/mask-env/mask-env.mjs",
              "--allow=.env.example",
              "--placeholder=<censurado>"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

**Sem `matcher`, de propósito** — o hook roda depois de *toda* tool. Este é o último ponto antes
de um segredo chegar ao modelo, e um matcher que esqueça uma tool nova (ou uma tool de MCP que
leia arquivo) vira um vazamento silencioso. O preço é um processo Node por chamada de tool
(~50 ms); o script sai calado em microssegundos quando nada de ambiente está envolvido. Se esse
custo incomodar, um matcher como `[Rr]ead|[Gg]rep|[Bb]ash|[Pp]ower[Ss]hell` cobre o caminho
comum — sabendo que passa a ser uma aposta sobre quais tools podem expor conteúdo de arquivo.

### Como a saída mascarada volta para o modelo

A substituição sai em `hookSpecificOutput.updatedToolOutput`, e o Claude Code **exige que o
valor tenha a mesma forma da saída original da tool**: um objeto `{stdout, stderr, interrupted,
isImage}` para o `Bash`, `{type, file: {filePath, content, ...}}` para o `Read`, e assim por
diante.

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PostToolUse",
    "updatedToolOutput": { "stdout": "DB_PASSWORD=<censurado>", "stderr": "", "interrupted": false, "isImage": false },
    "additionalContext": "Os valores de variaveis de ambiente foram mascarados..."
  }
}
```

**Um valor com a forma errada é descartado em silêncio e o texto cru chega ao modelo** — que é
exatamente o vazamento que o hook existe para evitar. Por isso o script nunca monta um objeto
novo: ele **clona** a saída original e troca só o conteúdo das strings, preservando chaves,
arrays, números e booleanos. O `selftest.mjs` tem um `assertSameShape` que trava essa regressão.

O mesmo vale para o fallback de erro: se o mascaramento falhar, não dá para devolver um
`updatedToolOutput` (a forma da saída seria um chute, e um chute errado é descartado). O script
então usa `decision: "block"` com um aviso, que o Claude Code coloca ao lado do resultado sem
depender de adivinhar schema nenhum.

---

## Como funciona

1. O Claude Code executa a tool (`Read`, `Bash`, `Grep`, etc.) normalmente — **a leitura não é bloqueada**.
2. Depois do sucesso, o hook recebe no `stdin` o payload de `PostToolUse`.
3. O script decide se aquela chamada tocou em ambiente:
   - algum caminho nos argumentos tem basename `.env`, `.env.*` ou `*.env` **e não está na allowlist**;
   - o comando de shell cita um desses arquivos (`cat ./.env | head -20`);
   - o comando é um dump de ambiente (`printenv`, `env`).
4. Se tocou, reescreve o texto do resultado e devolve:

```json
{
  "modifiedResult": { "resultType": "success", "textResultForLlm": "..." },
  "additionalContext": "Os valores de variaveis de ambiente foram mascarados..."
}
```

5. Se não tocou, **não imprime nada** e sai com `0` — o resultado original segue intacto.

### Arquivos liberados (allowlist)

Arquivos de exemplo trazem placeholders, não segredos — e o agente precisa deles para saber **quais variáveis existem**. Estes passam intactos:

```
.env.sample   .env.example   .env.template   .env.dist
```

A comparação é por *basename*, então `infra/.env.sample` também é liberado. Qualquer outro membro da família (`.env`, `.env.local`, `.env.production`, `staging.env`) é mascarado.

Em saída de `grep`/`rg`, que traz o caminho em cada linha, a decisão é **por linha**: uma busca nos dois arquivos devolve a linha do `.env.sample` legível e a do `.env` censurada.

Para mudar a lista, use `MASK_ENV_ALLOW` (basenames separados por vírgula). `MASK_ENV_ALLOW=` vazio mascara tudo, inclusive os samples.

### O que é preservado

- Nomes das variáveis, `export`, espaçamento e o `=`.
- Comentários sem atribuição (`# credenciais locais`).
- Linhas em branco e a contagem total de linhas.
- Variáveis sem valor (`EMPTY_VAR=` continua `EMPTY_VAR=`).
- Prefixos de numeração de linha da tool `view` (`   1→DATABASE_URL=...`).

### O que é mascarado

- Todo valor de `CHAVE=valor`, com ou sem aspas.
- **Atribuições comentadas** — `# OLD_DATABASE_URL=postgres://user:pw@host` é credencial viva, não comentário.
- **Valores multilinha entre aspas** (chaves privadas PEM): as linhas de continuação saem vazias até a aspa de fechamento.
- **Saída de `grep`/`rg`**, que prefixa cada acerto com `caminho:` ou `caminho:linha:` — o prefixo é preservado, o valor não.

---

## Configuração

| Argumento | Variável de ambiente equivalente | Padrão | Efeito |
|---|---|---|---|
| `--placeholder=` | `MASK_ENV_PLACEHOLDER` | `<censurado>` | Texto que substitui os valores |
| `--allow=` | `MASK_ENV_ALLOW` | `.env.sample,.env.example,.env.template,.env.dist` | Basenames liberados; vazio mascara tudo |

O argumento vence a variável de ambiente, que vence o default. Neste repositório o `--allow=`
está em `.env.example`, que é o arquivo de exemplo que existe aqui.

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/mask-env/mask-env.mjs",
  "--allow=.env.example,.env.template",
  "--placeholder=***"
]
```

---

## Testes

```bash
node .claude/hooks/mask-env/selftest.mjs
```

30 casos: arquivo `.env` típico, `.env.production`, `cat .env` via bash, `printenv`, `Get-Content` via powershell, saída de `rg` e de `grep` com prefixo de caminho, numeração de linha em seis formatos (`168. `, `12| `, `12→`, `12: `, `12\t`, `12) `), allowlist (as quatro variantes de exemplo, busca misturando `.env` e `.env.sample`, allowlist vazia), payload camelCase e snake_case, saída numerada, credencial comentada, chave privada multilinha, URL solta que não é atribuição, arquivo comum sem relação com env, `stdin` inválido, resultado vazio, e o contrato de saída: forma preservada para `Bash` e para `Read`, campos só dentro de `hookSpecificOutput`, e configuração por argumento.

### Por que o prefixo da linha não é uma lista de formatos

Duas falhas anteriores tiveram a mesma raiz: a regex assumia **onde** a chave começa na linha.

1. `rg '^DB_URL=.*$' .env` passava **sem mascarar**. O `rg` prefixa cada acerto com o caminho (`C:\...\.env:DB_URL=postgres://...`) e a regex exigia a chave na coluna 0 — o mesmo segredo saía censurado por um caminho de leitura e em claro por outro.
2. Uma leitura com intervalo de linhas numera como `168. ` — ponto e espaço. O prefixo aceitava tab, espaço, `:` e `|`, mas não `.`, e o trecho saiu em claro.

Daí o `parseAssignment`: ele acha o **primeiro `=`** da linha, caminha para a esquerda sobre os caracteres válidos de chave e preserva como prefixo tudo o que encontrar na frente — caminho, número de linha, `#`, `export`, qualquer combinação. Deixa de existir uma lista de formatos para acertar.

Dois guardas evitam o excesso: a chave precisa ter 2+ caracteres e forma de identificador, e é descartada se vier logo depois de `?` ou `&`. É o que mantém `https://user:pw@host/path?a=b` intacto.

---

## Limitações conhecidas

Vale entender o alcance real antes de confiar nisto como controle único:

1. **`PostToolUse` não tem como falhar fechado.** O evento roda *depois* da tool. Se o script quebrar, o runtime é fail-open. O script compensa capturando qualquer exceção e devolvendo o resultado inteiro suprimido — mas se o processo `node` não subir (Node ausente no PATH, timeout de 10s), o conteúdo original passa. Para bloqueio duro, o caminho é um hook de `preToolUse` com `permissionDecision: "deny"` — que é fail-closed, mas aí a leitura deixa de ser permitida, o oposto do que este hook faz.
2. **A detecção é por argumento da tool.** Busca com o `.env` no caminho (`rg PADRAO .env`) é coberta, inclusive o prefixo `caminho:linha:` da saída. Mas `grep -r "PG_SQL_CONN_URL" .`, que acha o valor em outro arquivo sem citar `.env`, passa. Ligue `MASK_ENV_SCAN_ALL=1` para cobrir parte disso.
3. **Só a forma `CHAVE=valor` é mascarada.** Um segredo em JSON, YAML ou dentro de uma string de código não é reconhecido.
4. **Não protege contra o próprio agente.** Um comando como `node -e "console.log(process.env.X.split('').join('-'))"` transforma o valor antes de imprimir, e a saída não tem forma de atribuição.
5. Isto reduz exposição acidental em contexto. **Não substitui** rotação de segredo, `.gitignore` e gestão de credenciais.
