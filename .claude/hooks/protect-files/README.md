# Hook `protect-files`

Hook de `PreToolUse` que **deixa o agente ler** os arquivos de configuração do projeto, mas **bloqueia qualquer tentativa de alterá-los**. Quando bloqueia, devolve ao modelo uma instrução explícita: pare de tentar e entregue a alteração para um humano aplicar.

```diff
  view jest.config.js             -> ok, o agente lê e entende as regras
- edit jest.config.js             -> negado
- echo "{}" > .prettierrc.json    -> negado
- sed -i 's/50/0/' jest.config.js -> negado
```

Ver [../README.md](../README.md) para o panorama dos hooks deste repositório, e a [referência oficial de hooks do Claude Code](https://code.claude.com/docs/en/hooks) para o contrato do runtime.

---

## Arquivos

| Arquivo                                      | Papel                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Registro do hook (é o arquivo lido pelo Claude Code) |
| [`protect-files.mjs`](protect-files.mjs)     | Script Node que decide `allow`/`deny`                |
| [`selftest.mjs`](selftest.mjs)               | Suíte de testes do script                            |
| `README.md`                                  | Este documento                                       |

O Claude Code lê a configuração de `.claude/settings.json` (versionado, vale para o projeto inteiro). Esta pasta guarda só o código dos hooks.

---

## Como está registrado

Em `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "[Ww]rite|[Ee]dit|[Nn]otebook|[Bb]ash|[Pp]ower[Ss]hell|[Ss]hell|[Cc]md|[Tt]erminal|apply_patch|create_file|str_replace",
        "hooks": [
          {
            "type": "command",
            "statusMessage": "protect-files",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files/protect-files.mjs",
              "--paths=.eslintrc*,eslint.config.*,...",
              "--allow=",
              "--message="
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Detalhes da forma de registro:

- **`command` + `args` (forma exec).** Com `args` presente, o `command` é resolvido como
  executável e chamado **sem shell**: cada item vira um argumento exato, sem aspas e sem
  expansão. **`timeout` é em segundos** (era `timeoutSec`) e **não existe campo `env` por
  hook**, daí a configuração vir por `args`.
- **A recusa sai em `hookSpecificOutput.permissionDecision`**, não no topo do objeto. No topo
  ela reprova a validação de schema e vira erro _não-bloqueante_, ou seja, a escrita passaria.
  O script também sai com **exit 2**, que em `PreToolUse` bloqueia sozinho mesmo se o stdout
  for descartado.
- **O `matcher` só é tratado como expressão regular** quando contém algum caractere fora de
  `[A-Za-z0-9_- ,|]`; com apenas letras e `|` ele vira uma lista de nomes **exatos**. Os `[Ww]`
  do padrão acima existem para mantê-lo no caminho de regex, o que faz um único padrão pegar
  `Write`, `Edit`, `MultiEdit`, `NotebookEdit`, `Bash` e `PowerShell` de uma vez.

O `matcher` é a primeira peneira — limita o hook às tools de escrita, evitando pagar o custo de um processo Node em toda leitura. O script **revalida por conta própria**: mesmo que o matcher seja ampliado para `*`, tools de leitura (`view`, `grep`, `glob`, `web_fetch`, …) passam em silêncio.

---

## Configuração (via `args` no settings.json)

| Argumento    | Variável de ambiente equivalente | Default                         | O que faz                                                                 |
| ------------ | -------------------------------- | ------------------------------- | ------------------------------------------------------------------------- |
| `--paths=`   | `PROTECT_FILES_PATHS`            | lint + jest + prettier (abaixo) | Lista separada por vírgula dos arquivos protegidos                        |
| `--allow=`   | `PROTECT_FILES_ALLOW`            | _(vazio)_                       | Exceções: casam com `PATHS` mas continuam editáveis                       |
| `--message=` | `PROTECT_FILES_MESSAGE`          | _(vazio)_                       | Texto extra anexado ao motivo do bloqueio (ex.: a quem pedir a alteração) |

O argumento vence a variável de ambiente, que vence o default. Um valor **vazio** (`--allow=`)
significa "nenhuma exceção", não "volte ao default". A variável de ambiente continua existindo
porque é o que o `selftest.mjs` usa; no dia a dia, configure pelo `args`.

**Neste repositório** o `--paths=` também inclui `tsconfig.json` e `tsconfig.*.json`. Eles não
estavam na lista de origem, mas o `verify-changes` proíbe explicitamente afrouxar o `tsconfig`
para fazer o build passar; proteger os dois arquivos faz a regra valer na prática, em vez de
depender de o agente obedecer ao texto. Para voltar ao comportamento original, remova os dois
últimos padrões do `--paths=` em `.claude/settings.json`.

### Protegidos por padrão

```
.eslintrc*        eslint.config.*     .eslintignore
jest.config.*     jest.setup.*
.prettierrc*      prettier.config.*   .prettierignore
```

### Sintaxe dos padrões

- Sem barra → compara com o **nome do arquivo**, em qualquer pasta: `jest.config.*` pega `jest.config.js` e `packages/api/jest.config.ts`.
- Com barra → compara com o **caminho**: `config/jest.config.js` pega só aquele; `outro/jest.config.js` passa.
- Curingas: `*` (dentro de um segmento), `**` (atravessa pastas), `?` (um caractere).
- A comparação ignora maiúsculas/minúsculas e normaliza `\` → `/`, `./`, `C:` e caminhos absolutos — `C:\repo\jest.config.js` e `/workspace/jest.config.js` casam com `jest.config.*`.

### Exemplo: proteger também o `tsconfig`, liberando o de teste

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/protect-files/protect-files.mjs",
  "--paths=.eslintrc*,eslint.config.*,jest.config.*,.prettierrc*,tsconfig*.json",
  "--allow=tsconfig.test.json",
  "--message=Alterações nesses arquivos passam por review do time de plataforma."
]
```

---

## Como funciona

1. O Claude Code vai executar uma tool de escrita e, **antes** disso, entrega o payload de `PreToolUse` no `stdin` do hook.
2. O script classifica a tool:
   - **leitura** (`view`, `grep`, `glob`, `task`, `web_*`, …) → libera na hora, sem analisar nada;
   - **shell** (`bash`, `powershell`) → analisa o comando;
   - **qualquer outra** → trata como escrita.
3. Percorre os argumentos e aplica duas regras diferentes:

| Tipo de campo    | Exemplos                                     | Regra                                                      |
| ---------------- | -------------------------------------------- | ---------------------------------------------------------- |
| Campo de caminho | `path`, `file_path`, `notebook_path`, `dest` | Casou com a lista → **nega**                               |
| Texto livre      | `command`, `content`, `input` (patch)        | Casou com a lista **e** tem marcador de escrita → **nega** |

A separação existe para um caso concreto: escrever um `README.md` que _menciona_ `jest.config.js` não é alterar o `jest.config.js`. Sem marcador de escrita junto, o texto passa.

4. Marcadores de escrita reconhecidos em texto livre:

   - redirecionamento (`>`, `>>`) — `2>&1` e `->` não contam;
   - `rm`, `mv`, `cp`, `tee`, `truncate`, `dd`, `touch`, `chmod`, `ln`, `patch`, …;
   - edição in-place: `sed -i`, `perl -pi`;
   - `git checkout|restore|apply|rm|mv|reset|clean|stash|revert`;
   - `prettier --write`, `eslint --fix`, `npm pkg set`;
   - PowerShell: `Set-Content`, `Out-File`, `Remove-Item`, `Move-Item`, `New-Item`, …;
   - Node/Python: `writeFileSync`, `appendFile`, `open(..., 'w')`, `[IO.File]::Write`;
   - cabeçalhos de patch: `*** Update File:`, `--- a/`, `+++ b/`, `diff --git`.

5. Ao negar, imprime uma linha e sai com `0`:

```json
{
  "permissionDecision": "deny",
  "permissionDecisionReason": "[protect-files] jest.config.js e um arquivo protegido..."
}
```

6. Ao liberar, **não imprime nada** e sai com `0` — silêncio significa "decisão padrão do runtime". Emitir `allow` seria pior: pré-aprovaria chamadas que deveriam passar pelo fluxo normal de permissão.

---

## O que o agente vê ao ser bloqueado

O `permissionDecisionReason` vai direto para o modelo. Ele diz, nesta ordem:

> `[protect-files] jest.config.js e um arquivo protegido deste repositorio: o agente pode ler, mas nao pode alterar. A chamada foi bloqueada (tool `edit`) e nada foi gravado. O que fazer agora: NAO tente outro caminho (shell, redirecionamento, patch, renomear, script, subagente) - o mesmo hook bloqueia todos. Siga com o restante da tarefa que nao depende dessa alteracao e, ao final, entregue ao humano um pedido de alteracao explicito com (1) o arquivo e o trecho exato, (2) o diff proposto, (3) o motivo e o que quebra sem ele, (4) como validar depois de aplicado.`

Três coisas de propósito:

- **diz que nada foi gravado** — sem isso o agente segue como se a edição tivesse acontecido e o resto do plano fica errado;
- **fecha os contornos explicitamente** — a reação natural do modelo a um `edit` negado é tentar `bash`, depois `apply_patch`. Dizer que todos caem no mesmo hook economiza a rodada de tentativas;
- **manda continuar o resto** — bloqueio de um arquivo não é motivo para abandonar a tarefa inteira.

O texto é ASCII sem acentos, como em [`mask-env`](../mask-env/README.md): a mensagem atravessa JSON, shell e dois sistemas operacionais até chegar ao modelo.

---

## Comportamento em falha

`PreToolUse` é **fail-closed** por definição do runtime: crash, exit ≠ 0 ou saída inválida negam a tool call. O script se alinha a isso de forma previsível:

| Situação                                         | Resultado                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Payload válido, arquivo protegido                | `deny` com motivo                                                                                                  |
| Payload válido, arquivo comum                    | silêncio (libera)                                                                                                  |
| `stdin` vazio (execução manual, fora do runtime) | silêncio — não há tool call para negar                                                                             |
| `stdin` presente mas ilegível                    | `deny`, com motivo pedindo para avisar o humano                                                                    |
| Exceção interna                                  | `deny`, citando o nome do erro                                                                                     |
| **Timeout**                                      | **fail-open** — o runtime libera a tool. Por isso `timeout: 10` (segundos) com um script sem I/O de disco nem rede |

Se o hook começar a negar _tudo_, o desligamento é remover a entrada dele de
[`../../settings.json`](../../settings.json), o que deixa os outros três hooks ativos. Para
desligar todos de uma vez, use `"disableAllHooks": true` na raiz do mesmo arquivo.

---

## Limitações conhecidas

- **Comandos destrutivos amplos não são detectados.** `git checkout .`, `git reset --hard`, `rm -rf .` não citam o arquivo protegido, então passam. O hook protege contra alteração dirigida, não contra reset do repositório.
- **O bloqueio de shell erra para o lado seguro.** `cat jest.config.js > /tmp/copia` é negado: há um arquivo protegido e há um redirecionamento na mesma linha, e o script não simula o shell para saber qual é o destino. Copie por outro caminho ou use a tool de leitura.
- **Vale só para o agente.** É um hook da sessão, não uma permissão de filesystem. O humano (e qualquer script fora da sessão) continua editando normalmente — que é exatamente a intenção.

---

## Testes

```bash
node .claude/hooks/protect-files/selftest.mjs
```

36 casos cobrindo bloqueio por tool de escrita, contornos via shell (redirecionamento, `sed -i`, `git checkout`, PowerShell, `node -e`, `apply_patch`), leitura liberada, os dois formatos de payload (camelCase e snake_case), caminhos absolutos de Windows e Linux, as três variáveis de configuração e o contrato de saída.
