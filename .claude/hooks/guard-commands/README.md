# Hook `guard-commands`

Hook de `PreToolUse` que **bloqueia comandos destrutivos ou irreversíveis** antes que a shell rode. Quando bloqueia, devolve ao modelo uma instrução explícita: pare de tentar e reporte ao humano _qual_ comando você tentou rodar e _por quê_, para que ele execute manualmente se concordar.

```diff
  git status                  -> ok
  npm test && npm run build   -> ok
- git push                    -> negado
- git push --force            -> negado
- npm test && git push        -> negado
- git reset --hard HEAD~1     -> negado
```

Ver [../README.md](../README.md) para o panorama dos hooks deste repositório, e a [referência oficial de hooks do Claude Code](https://code.claude.com/docs/en/hooks) para o contrato do runtime.

---

## Arquivos

| Arquivo                                      | Papel                                                |
| -------------------------------------------- | ---------------------------------------------------- |
| [`../../settings.json`](../../settings.json) | Registro do hook (é o arquivo lido pelo Claude Code) |
| [`guard-commands.mjs`](guard-commands.mjs)   | Script Node que decide `allow`/`deny`                |
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
        "matcher": "[Bb]ash|[Pp]ower[Ss]hell|[Ss]hell|[Cc]md|[Tt]erminal|run_command|execute_command|exec_command",
        "hooks": [
          {
            "type": "command",
            "statusMessage": "guard-commands",
            "command": "node",
            "args": [
              "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
              "--deny=git push,git branch -D,...",
              "--allow=git push --dry-run"
            ],
            "timeout": 10
          }
        ]
      }
    ]
  }
}
```

Três detalhes da forma de registro:

- **`command` + `args` (forma exec).** Com `args` presente, o `command` é resolvido como
  executável e chamado **sem shell** — cada item de `args` vira um argumento exato, sem aspas,
  sem expansão, sem `$` interpretado. É por isso que uma lista de regras com espaços passa
  inteira, sem escaping.
- **`${CLAUDE_PROJECT_DIR}`** é a raiz do projeto onde a sessão começou, então o hook funciona
  qualquer que seja o diretório do agente no momento da chamada.
- **`timeout` é em segundos** (era `timeoutSec`), e **não existe campo `env` por hook** — daí a
  configuração vir por `args`.

O `matcher` só é tratado como expressão regular quando contém algum caractere fora de
`[A-Za-z0-9_- ,|]`; com apenas letras e `|` ele vira uma lista de nomes **exatos**. Os `[Bb]`
existem para mantê-lo no caminho de regex.

O `matcher` é a primeira peneira — limita o hook às tools de execução, evitando pagar o custo de um processo Node em toda leitura. O script **revalida por conta própria**: mesmo que o matcher seja ampliado para `*`, tools de leitura (`view`, `grep`, `glob`, …) e de escrita de arquivo (`create`, `edit`, `apply_patch`) passam em silêncio — escrita de arquivo é assunto do [`protect-files`](../protect-files/README.md).

---

## Configuração (via `args` no settings.json)

| Argumento  | Variável de ambiente equivalente | Default              | O que faz                                           |
| ---------- | -------------------------------- | -------------------- | --------------------------------------------------- |
| `--deny=`  | `GUARD_COMMANDS_DENY`            | lista abaixo         | Comandos recusados, separados por vírgula           |
| `--allow=` | `GUARD_COMMANDS_ALLOW`           | `git push --dry-run` | Exceções: casam com `DENY` mas continuam permitidas |

O argumento vence a variável de ambiente, que vence o default. Um valor **vazio** (`--allow=`)
significa "nenhuma exceção" — não "volte ao default". A variável de ambiente continua existindo
porque é o que os `selftest.mjs` usam; no dia a dia, configure pelo `args`.

`ALLOW` é avaliado **antes** de `DENY`: o que casa com uma exceção nem chega a ser comparado com a lista de recusa.

### Recusados por padrão

```
git push                git reset --hard        git checkout -f
git clean -f            git branch -D           git filter-branch
git stash drop          git stash clear         git update-ref -d
git reflog delete       rm -rf                  npm publish
npm install             npm ci                  Remove-Item -Recurse -Force
```

### Sintaxe das regras

Cada regra é um comando escrito como você o digitaria. O script separa em **palavras** e **flags**:

- **Palavras** (`git`, `push`) precisam aparecer **na ordem**, em qualquer ponto de um segmento. Entre elas só podem existir flags e seus valores — por isso `git -c user.name=bot push` casa com `git push`, mas `git commit -m "push manual"` **não** casa.
- **Flags** (`--hard`, `-f`) podem aparecer em qualquer posição. Flags curtas casam coladas ou separadas: `-f` pega `-fd`, `-rf` e `-r -f`.
- Flags curtas são **case-sensitive** de propósito: a regra `git branch -D` não bloqueia `git branch -d`.
- Curingas `*` e `?` funcionam em qualquer token: `terraform destr*`, `git push origin refs/*`.
- Uma regra mais específica restringe o bloqueio: trocar `git push` por `git push --force` libera o push normal e barra só o forçado.

### Exemplo: liberar o push, barrar só o que reescreve histórico

```json
"args": [
  "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
  "--deny=git push --force,git push -f,git filter-branch,npm publish",
  "--allow=git push --force-with-lease"
]
```

---

## Como funciona

1. O Claude Code vai executar uma tool de shell e, **antes** disso, entrega o payload de `PreToolUse` no `stdin` do hook — uma chamada por invocação:

   ```json
   {
     "hook_event_name": "PreToolUse",
     "session_id": "...",
     "cwd": "...",
     "tool_name": "Bash",
     "tool_input": { "command": "git push --force", "description": "..." }
   }
   ```

   O `toolCallsOf()` também aceita um formato em lote (`toolCalls: [{ name, args }]`, com `args` como string JSON). Nenhum runtime usado aqui entrega isso, mas o suporte não custa nada e cobre uma tool de MCP que resolva empacotar chamadas.

2. O script escolhe o que analisar: apenas os campos de comando (`command`, `script`, `exec`, `args`, …). Se a tool não tiver nenhum deles, cai para todos os textos. Isso evita barrar um `description` que apenas _menciona_ o comando.
3. Quebra o comando em **segmentos** por `|`, `||`, `&&`, `;`, `&`, `$( )`, crase, parênteses e quebra de linha — cada segmento é um comando próprio. É o que impede `npm test && git push` de escapar.
4. Segmentos que só imprimem texto (`echo`, `printf`) são ignorados — exceto quando a saída é canalizada para um interpretador (`| bash`, `| node`, `| iex`), caso em que o comando inteiro volta a ser avaliado.
5. Para cada segmento: se casar com `ALLOW`, segue; se casar com `DENY`, nega.
6. Ao negar, responde pelos **três canais**, para que nenhuma mudança de leitura do runtime transforme um bloqueio em passagem silenciosa:

   - JSON no `stdout`, com a decisão **dentro de `hookSpecificOutput`** — no topo do objeto ela reprovaria a validação de schema e viraria erro _não-bloqueante_, ou seja, o comando rodaria:
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "permissionDecision": "deny",
         "permissionDecisionReason": "[guard-commands] comando bloqueado: `git push --force`..."
       }
     }
     ```
   - o mesmo motivo no `stderr`;
   - **exit code 2**, que em `PreToolUse` bloqueia sozinho, mesmo se o `stdout` for descartado. O runtime usa o `permissionDecisionReason` do JSON como mensagem quando ele existe, e cai no `stderr` quando não existe.

7. Ao liberar, **não imprime nada** e sai com `0` — silêncio significa "decisão padrão do runtime". Emitir `allow` seria pior: pré-aprovaria chamadas que deveriam passar pelo fluxo normal de permissão.

---

## O que o agente vê ao ser bloqueado

O `permissionDecisionReason` vai direto para o modelo:

> ``[guard-commands] comando bloqueado: `git push --force origin main`. Ele casa com a regra `git push` de comandos destrutivos/irreversiveis deste repositorio, nao foi executado e nada mudou. O que fazer agora: NAO tente outro caminho (outra flag, alias, script, subagente, outra shell, git plumbing) - o mesmo hook bloqueia todos. Siga com o restante da tarefa que nao depende desse comando e, ao final, informe ao humano em texto claro: (1) o comando exato que voce tentou executar, (2) por que voce queria executa-lo agora, (3) o que fica pendente enquanto ele nao roda. Quem decide e executa esse comando e o humano, manualmente.``

Quatro coisas de propósito:

- **cita o comando exato** — o agente precisa repassá-lo ao humano; se a mensagem não o cita, ele reconstrói de memória e erra a flag;
- **diz que nada foi executado** — sem isso o agente segue como se o push tivesse acontecido e o resto do plano fica errado;
- **fecha os contornos explicitamente** — a reação natural do modelo a um `git push` negado é tentar outra flag, depois um script. Dizer que todos caem no mesmo hook economiza a rodada de tentativas;
- **pede a razão junto do comando** — o humano decide com contexto ("queria publicar a branch para abrir o PR") em vez de receber só um comando solto.

O texto é ASCII sem acentos, como em [`mask-env`](../mask-env/README.md) e [`protect-files`](../protect-files/README.md): a mensagem atravessa JSON, shell e dois sistemas operacionais até chegar ao modelo.

---

## Comportamento em falha

`PreToolUse` é **fail-closed** por definição do runtime: crash, exit ≠ 0 ou saída inválida negam a tool call. O script se alinha a isso de forma previsível:

| Situação                                         | Resultado                                                                                                          |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Payload válido, comando na lista de recusa       | `deny` com motivo                                                                                                  |
| Payload válido, comando comum                    | silêncio (libera)                                                                                                  |
| `stdin` vazio (execução manual, fora do runtime) | silêncio — não há tool call para negar                                                                             |
| `stdin` presente mas ilegível                    | `deny`, com motivo pedindo para avisar o humano                                                                    |
| Exceção interna                                  | `deny`, citando o nome do erro                                                                                     |
| **Timeout**                                      | **fail-open** — o runtime libera a tool. Por isso `timeout: 10` (segundos) com um script sem I/O de disco nem rede |

Se o hook começar a negar _tudo_, o desligamento é remover a entrada dele de
[`../../settings.json`](../../settings.json), o que deixa os outros três hooks ativos. Para
desligar todos de uma vez, use `"disableAllHooks": true` na raiz do mesmo arquivo.

---

## Limitações conhecidas

- **A config é lida na abertura da sessão.** Editar o `--deny=` em `settings.json` não afeta
  uma sessão já aberta — reinicie antes de testar. Para ver o que o hook decidiu, rode a sessão
  com log de debug (`claude --debug`), ou chame o script direto:
  ```bash
  echo '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"git push"}}' \
    | node .claude/hooks/guard-commands/guard-commands.mjs
  ```
  Saída vazia e exit `0` significam que o hook rodou e **liberou**.
- **Bloqueia pela forma escrita.** `npm install` é barrado, `npm i` não — cada variante precisa estar na lista.
- **Não entende o shell de verdade.** Alias (`alias gp='git push'`), variável (`CMD="git push"; $CMD`) ou base64 escapam. O alvo é o agente cooperativo que tenta a rota óbvia, não um adversário.
- **Bloqueia por forma, não por efeito.** Um comando destrutivo fora da lista passa (`dd`, `truncate`, `DROP TABLE` via `psql`). Mantenha a lista alinhada ao que o time considera irreversível.
- **Erra para o lado seguro em comando composto.** `git log && git push` é negado inteiro — não há execução parcial: o runtime nega a tool call, e nem o `git log` roda.
- **Vale só para o agente.** É um hook da sessão, não uma proteção de repositório. O humano continua executando tudo normalmente — que é exatamente a intenção. Para garantia de verdade em `git push --force`, use branch protection no GitHub.

---

## Testes

```bash
node .claude/hooks/guard-commands/selftest.mjs
```

54 casos cobrindo os comandos recusados por padrão, contornos (`&&`, `;`, subshell, `bash -c`, `sudo`, `git -c`, `echo | bash`, `exec` + `args`), comandos legítimos que devem passar, os dois formatos de payload (camelCase e snake_case), o payload em lote (`toolCalls[]` com `args` em string JSON, várias chamadas numa invocação), as duas variáveis de configuração e o contrato de saída (JSON + stderr + exit 2).
