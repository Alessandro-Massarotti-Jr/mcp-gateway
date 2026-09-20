# Hook `verify-changes`

Hook de `Stop` que **impede o agente de encerrar uma tarefa deixando o projeto quebrado**. Quando a tarefa mexeu em `src/`, ele roda `format` (para o resultado final sair no padrão), depois `lint`, `build` e `test`, e só libera o encerramento depois de mostrar o resultado de cada um.

```diff
  "o que faz esse arquivo?"        -> nenhum comando roda (nada mudou em src/), só a linha de status
  "explique esse fluxo"            -> idem
+ "corrija o bug em src/routes.ts" -> format + lint + build + test antes de encerrar
```

Em **todo** encerramento o agente é obrigado a dizer se a verificação rodou e com que resultado — silêncio não é opção, porque não dá para distinguir "não havia nada a verificar" de "o hook não está carregado".

Ver [../README.md](../README.md) para o panorama dos hooks deste repositório, e a [referência oficial de hooks do Claude Code](https://code.claude.com/docs/en/hooks) para o contrato do runtime.

---

## Arquivos

| Arquivo | Papel |
|---|---|
| [`../../settings.json`](../../settings.json) | Registro do hook (é o arquivo lido pelo Claude Code) |
| [`verify-changes.mjs`](verify-changes.mjs) | Script Node que decide `block`/`allow` e roda os comandos |
| [`selftest.mjs`](selftest.mjs) | Suíte de testes do script |
| `README.md` | Este documento |

O Claude Code lê a configuração de `.claude/settings.json` (versionado, vale para o projeto inteiro). Esta pasta guarda só o código dos hooks.

---

## O que ele faz, em ordem

1. **`SessionStart`** — tira uma *impressão digital* dos caminhos observados (hash do conteúdo de cada arquivo sob `src/`) e guarda como baseline da sessão. Também injeta uma linha de contexto avisando o agente de que o gate existe.
2. **`Stop`** — recalcula a impressão digital:
   - **igual ao baseline** → o agente só leu/explorou; nenhum comando roda e o hook apenas pede uma linha de status ao agente (ver [`VERIFY_CHANGES_NOTIFY`](#o-agente-avisa-em-todo-encerramento-verify_changes_notify));
   - **diferente** → roda `npm run format`, `npm run lint`, `npm run build`, `npm run test`.
3. **Roda todos os comandos**, sem parar no primeiro erro, e devolve um relatório com o resultado de cada um.
4. **Bloqueia o encerramento** (`decision: "block"`) e devolve o relatório como prompt do próximo turno:
   - **com falhas** → "corrija e encerre de novo" (a verificação roda outra vez sozinha);
   - **sem falhas** → "encerre, mas inclua este relatório na resposta final ao usuário".

O bloqueio "sem falhas" acontece **uma única vez** — o turno seguinte passa direto. É o que garante o requisito de o agente sempre contar ao usuário o que foi verificado.

---

## O agente avisa em todo encerramento (`--notify=`)

Silêncio é ambíguo: não dá para distinguir "não havia nada a verificar" de "o hook não está carregado". Por isso, no default `always`, **todo** encerramento produz um status — inclusive quando nenhum comando rodou:

```
[verify-changes] Status da verificacao neste encerramento: NENHUM comando executado -
nada mudou em src desde o inicio da sessao.

Comandos que rodariam se houvesse alteracao: npm run format, npm run lint, npm run build, npm run test.

O que fazer agora: nao refaca nada, nao repita a resposta anterior e nao rode esses comandos
por conta propria. Apenas encerre acrescentando UMA linha curta de status ao usuario (...)
```

O aviso de "não rodou" custa **uma linha**, não um ciclo de trabalho — o texto proíbe explicitamente o agente de refazer a tarefa ou rodar os comandos na mão. Os relatórios de execução (sucesso e falha) continuam trazendo o resultado comando a comando.

| Valor | Comportamento |
|---|---|
| `always` *(default)* | Avisa em todo encerramento: executou (com resultados) ou não executou (com o motivo) |
| `on-run` | Só fala quando algum comando rodou; "nada mudou em `src/`" passa em silêncio |
| `on-error` | Só fala quando alguma verificação falha |

### Os dois silêncios perigosos

Há dois estados em que o hook **para de funcionar** e a sessão fica idêntica a uma em que tudo passou. Nos dois, ele avisa antes de calar — uma vez só:

| Estado | Aviso |
|---|---|
| Gate desarmado (teto de bloqueios atingido) | `o gate SE DESARMOU apos N bloqueios` — e que dali em diante nada mais é verificado |
| Hook quebrado (erro interno) | `o hook QUEBROU e nao executou nada` — com o erro, e a nota de que lint/build/test não rodaram |

O aviso de desarme custa **um bloqueio além do teto** (7 no default, contra os 8 do runtime): desarmar calado é o pior silêncio possível, porque é justamente quando a rede de segurança sumiu.

Os dois avisos são gravados no estado antes de sair, e **só bloqueiam se a gravação der certo**. Se o defeito for no próprio disco, insistir a cada encerramento transformaria a falha em loop.

> **Por que isso não vira loop:** o turno que *entrega* o aviso também termina em `Stop`, e ali também não houve alteração. Sem guarda, seria aviso → turno → aviso até estourar `MAX_BLOCKS`. O estado marca `pendingReport`; o encerramento seguinte apenas limpa a marca e passa direto. Resultado: **no máximo um aviso por pergunta do usuário**.

### Por que hash de conteúdo e não `mtime`

O `format` reescreve os arquivos. Com `mtime`, o próprio prettier marcaria `src/` como "alterado" e o hook se auto-dispararia em loop. O baseline é sempre recalculado **depois** dos comandos, já com o código formatado.

### Por que baseline de sessão e não `git status`

O repositório quase sempre tem alterações não commitadas em `src/`. Se o gatilho fosse `git status`, **toda pergunta** viraria um build completo — exatamente o incômodo que este hook deve evitar. O baseline compara com o estado do início da sessão, então só o que **o agente** mexeu conta.

`git status --porcelain -- src` continua sendo usado como *fallback* quando não há baseline (sessão retomada, ou hook instalado no meio da sessão).

---

## Como está registrado

Em `.claude/settings.json`. O `--event=agentStop` é o nome interno do script para o
encerramento de turno, e não o nome do evento do runtime, que é `Stop`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume|clear",
        "hooks": [
          {
            "type": "command",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
              "--event=sessionStart",
              "--paths=src"
            ],
            "timeout": 30
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "statusMessage": "verify-changes: format, lint, build, test",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
              "--event=agentStop",
              "--paths=src",
              "--format=format",
              "--commands=lint,build,test",
              "--max-attempts=3",
              "--budget-sec=900",
              "--command-timeout-sec=300",
              "--max-blocks=6",
              "--notify=always"
            ],
            "timeout": 960
          }
        ]
      }
    ]
  }
}
```

O `matcher` do `SessionStart` é **`startup|resume|clear`**, e a ausência de `compact` e `fork` é
deliberada: o baseline nasce nesse evento, e recriá-lo numa compactação apagaria a memória das
alterações feitas antes dela — o encerramento seguinte concluiria "nada mudou" e não verificaria
nada.

> `timeout` do `Stop` precisa ser **maior** que `--budget-sec`. Timeout de hook é sempre *fail-open*: o runtime mata o processo e o turno encerra **sem** verificação nenhuma — e sem relatório. Os 960s contra 900s de orçamento existem para o script sempre terminar por conta própria, com relatório, antes de o runtime perder a paciência.

---

## Configuração (via `args` no settings.json)

| Argumento | Variável de ambiente equivalente | Default | O que faz |
|---|---|---|---|
| `--paths=` | `VERIFY_CHANGES_PATHS` | `src` | Caminhos observados, separados por vírgula. `/src`, `./src` e `src` são equivalentes |
| `--format=` | `VERIFY_CHANGES_FORMAT` | `format` | Script rodado **antes** das verificações. Vazio = não formata |
| `--commands=` | `VERIFY_CHANGES_COMMANDS` | `lint,build,test` | Scripts npm verificados, na ordem. Vazio = desliga o gate |
| `--max-attempts=` | `VERIFY_CHANGES_MAX_ATTEMPTS` | `3` | Ciclos de correção antes de o hook desistir e mandar relatar |
| `--budget-sec=` | `VERIFY_CHANGES_BUDGET_SEC` | `900` | Tempo total de execução de comandos por sessão |
| `--command-timeout-sec=` | `VERIFY_CHANGES_COMMAND_TIMEOUT_SEC` | `300` | Timeout de cada comando individual |
| `--max-blocks=` | `VERIFY_CHANGES_MAX_BLOCKS` | `6` | Teto absoluto de bloqueios por sessão |
| `--notify=` | `VERIFY_CHANGES_NOTIFY` | `always` | Quando o agente é obrigado a reportar. `always` \| `on-run` \| `on-error` |
| `--state-dir=` | `VERIFY_CHANGES_STATE_DIR` | `<tmp>/claude-verify-changes` | Onde fica o estado da sessão |

O argumento vence a variável de ambiente, que vence o default. Um valor **vazio** (`--commands=`)
significa "não rode verificação nenhuma" — não "volte ao default".

> `--max-blocks=6` fica abaixo do teto do próprio Claude Code: **após 8 bloqueios consecutivos o
> runtime ignora o hook e encerra o turno**. Os 6 existem para o hook desistir com relatório e
> explicação antes de o runtime desistir sem dizer nada.

Ignorados na varredura: `node_modules`, `.git`, `dist`, `build`, `out`, `coverage`, `.next`, `.turbo`, `.cache`.

### Observar mais de uma pasta

```json
"--paths=src,prisma,seeds"
```

### Desligar temporariamente

Passe `--commands=` e `--format=` vazios, o que desliga só este gate:

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/verify-changes/verify-changes.mjs",
  "--event=agentStop",
  "--commands=",
  "--format="
]
```

Para desligar **todos** os hooks do projeto de uma vez, use `"disableAllHooks": true` na raiz de
`.claude/settings.json`.

---

## Comando que não existe no `package.json`

Não é falha. O comando aparece no relatório como não executado, com o motivo, e **o agente encerra normalmente**:

```
  npm run lint    ->  OK (3.1s)
  npm run build   ->  OK (7.4s)
  npm run test    ->  NAO EXECUTADO: o script "test" nao existe no package.json
```

O agente é instruído a repassar essa linha ao usuário na resposta final — a ideia é que a ausência do script apareça para um humano, não que ela pare o trabalho.

---

## Critérios de parada

Um gate de `Stop` é um loop por construção: ele bloqueia o fim do turno e o agente volta a trabalhar. Três freios independentes garantem que esse loop **sempre** termine:

| Freio | Default | O que acontece ao estourar |
|---|---|---|
| Tentativas | 3 ciclos com falha | Relatório final: "PARE de tentar corrigir, reporte ao usuário" |
| Orçamento de tempo | 900s de comandos por sessão | Idem, citando o estouro de tempo |
| Teto de bloqueios | 6 bloqueios na sessão | Hook se desarma em silêncio (rede de segurança contra bug próprio) |

Ao estourar tentativas ou orçamento, o hook bloqueia **uma última vez** com o relatório completo e a instrução de reportar as falhas ao usuário — e depois disso não bloqueia mais. O agente entrega a resposta com o que ficou pendente, em vez de ficar preso.

O runtime tem o seu próprio limite (8 continuações `block` consecutivas, ver [a referência de hooks](https://code.claude.com/docs/en/hooks)); os defaults daqui ficam abaixo dele de propósito, para quem decide parar ser o hook — que tem o relatório em mãos — e não o runtime, que apenas desiste calado.

### Encerrar sem corrigir não escapa do gate

Se o agente para de editar e tenta encerrar com as falhas de pé, o hook bloqueia de novo (o estado guarda `failing`) até as tentativas acabarem. Não dá para escapar da verificação simplesmente não mexendo mais em `src/`.

---

## O que o agente é proibido de fazer para "passar"

O texto do bloqueio é explícito: nada de desativar regra de lint, marcar teste como skip, usar `ts-ignore`/`any` ou alterar arquivo de configuração. Os arquivos de config (`eslint`, `jest`, `prettier`) já são protegidos em separado pelo hook [`protect-files`](../protect-files/README.md) — os dois se reforçam.

---

## A saída é sempre um JSON, nunca silêncio

Bloquear é `{"decision":"block","reason":"..."}` no stdout. **Liberar é não mandar `decision`
nenhum**: `"allow"` não existe no schema de `Stop`, e emiti-lo faz o turno ganhar um aviso de
erro de hook a cada encerramento.

Mesmo liberando, o hook responde um JSON — sair calado é indistinguível de hook que não rodou,
de crash e de timeout. O que ele manda é um `systemMessage`, que em `Stop` vai só para o log de
debug (visível com `claude --debug`):

```json
{ "systemMessage": "[verify-changes] nenhum comando executado: nada mudou em src desde o inicio da sessao" }
```

O diagnóstico vai nesse campo, e nunca em `reason` ou `additionalContext`: esses dois
**continuam a conversa** no Claude Code, então um texto de diagnóstico viraria trabalho para o
agente. As três mensagens possíveis:

```
[verify-changes] nenhum comando executado: nada mudou em src desde o inicio da sessao
[verify-changes] teto de 6 bloqueios atingido nesta sessao; o gate esta desarmado
[verify-changes] payload de Stop ilegivel; encerramento liberado sem verificacao
```

### Bloqueio sai com exit `0` — e isso não é detalhe

O padrão de três canais que o `guard-commands` usa em `PreToolUse` (stdout + stderr + exit `2`)
**não se aplica** aqui. Em `Stop` o exit `2` também bloqueia, mas com duas diferenças que
importam: a mensagem passa a vir do **stderr** em vez do `reason`, e o turno é marcado como
**erro de hook** em vez de feedback normal. O relatório de lint/build/test chegaria ao agente
como texto de erro de runtime.

Por isso, ao bloquear: **exit `0`, `reason` no stdout e nada no stderr**. Há assert no selftest
travando as duas coisas.

---

## Estado é chaveado pelo `cwd`, não pelo `sessionId`

O arquivo de estado liga o baseline gravado no `SessionStart` ao contador de tentativas lido no
`Stop`. Se a chave divergir entre os dois eventos, o estado se espalha por vários arquivos e o
hook quebra de um jeito silencioso:

- o baseline do `SessionStart` fica invisível no encerramento, que cai no fallback do
  `git status` e roda a suíte inteira à toa;
- o contador de tentativas nunca acumula — o sintoma é `tentativa 1 de 3` repetida, sem nunca
  chegar ao relatório final.

O `cwd` é a chave por ser o campo mais estável entre os dois eventos: ele identifica o projeto,
não a invocação. Efeito colateral aceito: duas sessões no mesmo repositório compartilham
contador — o que é coerente, já que o que está sendo protegido é o repositório.

---

## `stop_hook_active`: a guarda que não depende do arquivo de estado

O runtime entrega `stop_hook_active: true` quando **aquele turno já foi forçado a continuar**, e ignora o hook após 8 continuações seguidas. O contador próprio deste hook vive em disco e pode sumir (tmp limpo, `sessionId` novo) — quando isso acontece no meio de um ciclo, contar do zero somaria bloqueios novos em cima dos que o runtime já concedeu.

Por isso: se `stop_hook_active` é `true` **e** o contador está zerado, o hook salta direto para o último bloqueio disponível. Ele gasta no máximo mais um, com relatório, em vez de empurrar o turno até o runtime desistir calado.

---

## Fail-open, de propósito

Diferente de `PreToolUse` (fail-closed), este hook **sai do caminho quando quebra**: payload ilegível, `package.json` ausente, erro interno ou timeout resultam em `allow` com aviso no log de debug. Um gate de qualidade com bug não pode impedir o agente de entregar a resposta.

---

## Testes

```bash
node .claude/hooks/verify-changes/selftest.mjs
```

A suíte roda contra um projeto-fixture descartável em `os.tmpdir()`, nunca contra o repositório real — os "comandos" da fixture são `node -e` de milissegundos, então ela exercita a máquina de estados (gatilho, relatório, tentativas, orçamento, teto) sem pagar lint/build/teste de verdade.

Cobre, entre outros: alteração dentro e fora de `src/`, reescrita com conteúdo idêntico, `/src` normalizado, todos os comandos rodando apesar de falha no meio, script ausente, o bloqueio único de sucesso, os três modos de `NOTIFY`, a garantia de que o aviso de "não rodou" não se auto-alimenta, os três critérios de parada e os caminhos de fail-open.

---

## Limitação conhecida neste repositório (Windows)

O script `test` do `package.json` é `TZ=UTC && jest ...`. `TZ=UTC` é sintaxe de shell Unix; no Windows o npm executa scripts via `cmd.exe`, que responde:

```
'TZ' não é reconhecido como um comando interno ou externo
```

Ou seja: **no Windows `npm run test` falha antes de o jest começar**, e o hook vai reportá-lo como `FALHOU exit 1` toda vez. Isso é do `package.json`, não do hook — e é justamente o tipo de coisa que o relatório expõe. Duas saídas, ambas fora do escopo deste hook:

- trocar o script por `cross-env TZ=UTC jest ...` (funciona nos dois sistemas); ou
- configurar `npm config set script-shell bash` na máquina.

Enquanto isso, o limite de 3 tentativas impede que essa falha prenda o agente: ele bloqueia 3 vezes, entrega o relatório e libera.
