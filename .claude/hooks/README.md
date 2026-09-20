# Hooks deste repositório

Quatro hooks do Claude Code, registrados em [`../settings.json`](../settings.json). Esta pasta
guarda só o código.

| Hook                                         | Evento                  | O que faz                                                                                                                                      |
| -------------------------------------------- | ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| [`guard-commands`](guard-commands/README.md) | `PreToolUse`            | Recusa comandos destrutivos ou irreversíveis (reescrita de histórico, remoção recursiva, publicação de pacote) antes de a shell rodar          |
| [`protect-files`](protect-files/README.md)   | `PreToolUse`            | O agente pode **ler** os arquivos de configuração de ESLint, Jest, Prettier e TypeScript, mas não alterá-los                                   |
| [`mask-env`](mask-env/README.md)             | `PostToolUse`           | Substitui valores de variáveis de ambiente por um placeholder antes de o resultado chegar ao modelo. Os nomes das variáveis continuam visíveis |
| [`verify-changes`](verify-changes/README.md) | `SessionStart` + `Stop` | Se a sessão mexeu em `src`, roda `format`, `lint`, `build` e `test` antes de deixar o turno encerrar                                           |

Cada pasta tem um `README.md` próprio com a configuração, os critérios de decisão e as
limitações conhecidas. A referência do runtime é a
[documentação oficial de hooks do Claude Code](https://code.claude.com/docs/en/hooks).

## Testes

Cada hook tem uma suíte que roda o script de verdade, por stdin, e confere o JSON de saída.
Elas não tocam no repositório: o `verify-changes` monta projetos-fixture descartáveis em
`os.tmpdir()` cujos "comandos" são `node -e` de milissegundos.

```bash
node .claude/hooks/guard-commands/selftest.mjs
node .claude/hooks/protect-files/selftest.mjs
node .claude/hooks/mask-env/selftest.mjs
node .claude/hooks/verify-changes/selftest.mjs
```

## Como os hooks são registrados

Não existe campo `env` por hook no `settings.json`. A configuração é passada por **argumento de
linha de comando**, usando a forma exec (`command` + `args`): com `args` presente, o `command` é
resolvido como executável e chamado **sem shell**, então cada item vira um argumento exato, sem
aspas, sem expansão e sem `$` interpretado. É o que permite passar uma lista de regras com
espaços sem escaping nenhum.

```json
{
  "type": "command",
  "command": "node",
  "args": [
    "${CLAUDE_PROJECT_DIR}/.claude/hooks/guard-commands/guard-commands.mjs",
    "--deny=git push,...",
    "--allow=git push --dry-run"
  ],
  "timeout": 10
}
```

Cada script resolve o valor nesta ordem: **argumento, variável de ambiente, default**. As
variáveis de ambiente continuam existindo porque são o que as suítes de teste usam. Um valor
**vazio** (`--allow=`) significa "nenhuma exceção", nunca "volte ao default" — os scripts usam
`??` e não `||` justamente para preservar isso.

O `${CLAUDE_PROJECT_DIR}` é a raiz do projeto onde a sessão começou, então os hooks funcionam
qualquer que seja o diretório do agente no momento da chamada.

Sobre o `matcher`: ele só é tratado como **expressão regular** quando contém algum caractere
fora de `[A-Za-z0-9_- ,|]`. Com apenas letras e `|` ele vira uma lista de nomes **exatos**, o
que silenciosamente deixa de casar com variações. Os `[Bb]` dos padrões em `settings.json`
existem para mantê-los no caminho de regex.

## Onde fica a decisão, no JSON de saída

Esta é a parte que mais dá silêncio quando erra. O runtime **valida o objeto inteiro**: um campo
de decisão no lugar errado não é ignorado — ele reprova a validação e a chamada vira um erro
_não-bloqueante_, ou seja, **a ação que deveria ser barrada acontece**.

| Evento            | Como decidir                                                                                                                   |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `PreToolUse`      | `{ "hookSpecificOutput": { "hookEventName": "PreToolUse", "permissionDecision": "deny", "permissionDecisionReason": "..." } }` |
| `PostToolUse`     | `{ "hookSpecificOutput": { "hookEventName": "PostToolUse", "updatedToolOutput": ... } }`                                       |
| `SessionStart`    | `{ "hookSpecificOutput": { "hookEventName": "SessionStart", "additionalContext": "..." } }`                                    |
| `Stop`            | `{ "decision": "block", "reason": "..." }` — no topo do objeto, e não em `hookSpecificOutput`                                  |
| Liberar em `Stop` | não mandar `decision`; `"allow"` **não existe** no schema                                                                      |

Dois pontos que valem destaque:

1. **`updatedToolOutput` precisa ter a mesma forma da saída original da tool** (um objeto
   `{stdout, stderr, interrupted, isImage}` para o `Bash`, outro para o `Read`). Um valor com
   forma diferente é descartado em silêncio e o conteúdo cru chega ao modelo. Por isso o
   `mask-env` clona a saída e troca só o conteúdo das strings, em vez de montar um objeto novo.
2. **Emitir `{"decision": "allow"}` em `Stop`** faz o turno ganhar um aviso de erro de hook a
   cada encerramento. O `verify-changes` usa `systemMessage`, que em `Stop` vai só para o log de
   debug.

## Exit codes

Em `PreToolUse`, o **exit 2 bloqueia sozinho**, mesmo que o stdout seja descartado. Os dois
hooks de `PreToolUse` usam os dois canais (JSON + exit 2).

Em `Stop` vale o contrário: exit 2 também bloqueia, mas a mensagem passa a vir do stderr e o
turno é marcado como erro de hook. Por isso o `verify-changes` bloqueia com **exit 0** e o
`reason` no stdout.

## Tetos de loop

O runtime encerra o turno por conta própria **após 8 bloqueios consecutivos** de `Stop`. O
`--max-blocks=6` do `verify-changes` fica abaixo disso de propósito: quem desiste primeiro é o
hook, que tem o relatório em mãos, e não o runtime, que apenas para sem explicar.

## Limitações conhecidas

- **Falso positivo do `protect-files` em texto.** O hook bloqueia uma escrita quando o conteúdo
  da chamada traz, ao mesmo tempo, o nome de um arquivo protegido e um "marcador de escrita"
  (redirecionamento de shell, patch unificado, um `--fix`, uma citação em blockquote de
  markdown). Isso inclui **documentação sobre os próprios arquivos protegidos**: editar o
  `protect-files/README.md` esbarra nele. O bloqueio é conservador de propósito, mas quando
  acontecer em um arquivo que claramente não é protegido, vale conferir se foi este caso.
- **Custo do `mask-env`.** Ele roda sem `matcher`, ou seja, depois de toda chamada de tool
  (~50 ms de processo Node). É deliberado: é o último ponto antes de um segredo chegar ao
  modelo. O `mask-env/README.md` explica como estreitar isso, e o que se perde.
- **Escopo do `mask-env`.** Quando ele decide que um resultado envolve variáveis de ambiente,
  mascara **todo** par `chave=valor` daquele resultado, não só os segredos. Uma saída de
  diagnóstico no mesmo texto sai mascarada junto.
