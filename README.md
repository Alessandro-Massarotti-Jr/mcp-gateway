# MCP Gateway

Servidor **MCP (Model Context Protocol)** em Node.js + TypeScript que expõe, por
HTTP, um conjunto de ferramentas para **PostgreSQL**, **MongoDB** (instância
própria ou Atlas) e **RabbitMQ**. Feito para rodar em container e ser o único
endpoint que o agente precisa conhecer para falar com a sua infraestrutura.

---

## Sumário

- [Como funciona](#como-funciona)
- [Padrão de nomes das tools](#padrão-de-nomes-das-tools)
- [Contrato de resposta](#contrato-de-resposta)
- [Ferramentas disponíveis](#ferramentas-disponíveis)
- [Configuração (variáveis de ambiente)](#configuração-variáveis-de-ambiente)
- [Executando com Docker](#executando-com-docker)
- [Desenvolvimento local](#desenvolvimento-local)
- [Conectando um agente](#conectando-um-agente)
- [Endpoints HTTP](#endpoints-http)
- [Arquitetura](#arquitetura)
- [Adicionando um novo provider](#adicionando-um-novo-provider)

---

## Como funciona

O gateway sobe um servidor HTTP com o transporte **Streamable HTTP** do MCP em
modo **stateless**: cada requisição cria seu próprio servidor MCP e transporte,
sem sessão compartilhada. Isso permite escalar o container horizontalmente sem
sticky session.

As conexões com os backends (pool do PostgreSQL, client do MongoDB, conexão AMQP)
são **singletons de processo**: sobrevivem entre requisições e são reaproveitadas.

Cada provider é **opcional**. Se a variável de conexão não estiver definida,
nenhuma tool daquele provider é registrada — o gateway sobe normalmente com o
resto. Um backend fora do ar também não impede o gateway de iniciar: a conexão é
tentada de novo sob demanda.

---

## Padrão de nomes das tools

```
{GATEWAY_NAME}_{PROVIDER_NAME}_{TOOL_NAME}
```

Os três segmentos são normalizados para maiúsculas com underscore (acentos e
símbolos viram `_`). A única exceção é a tool de diagnóstico do próprio gateway,
que não tem segmento de provider:

```
{GATEWAY_NAME}_CHECK_PROVIDERS_STATUS
```

Com `GATEWAY_NAME=ACME`, os nomes ficam `ACME_POSTGRES_QUERY`,
`ACME_MONGO_FIND`, `ACME_RABBITMQ_PUBLISH_TO_QUEUE`, `ACME_CHECK_PROVIDERS_STATUS`
e assim por diante.

> Clientes MCP costumam limitar o nome da tool a 64 caracteres. O gateway registra
> um `warn` no log se algum nome passar desse limite — nesse caso, encurte o
> `GATEWAY_NAME`.

---

## Contrato de resposta

**Toda** tool responde com o mesmo envelope, entregue tanto em
`structuredContent` quanto como JSON no bloco de texto:

```ts
export type ToolErrorCategory = 'transient' | 'validation' | 'business' | 'permission';

export type ToolResponse<T = unknown> = {
  isError: boolean;
  errorCategory?: ToolErrorCategory | null;
  isRetryable?: boolean | null;
  message: string; // técnica, para log e depuração
  userFriendlyMessage: string; // pronta para o agente repassar ao usuário
  data?: T | null;
};
```

O envelope também é publicado como `outputSchema` de cada tool, então o agente
conhece o formato antes de chamar.

### Categorias de erro

| Categoria    | `isRetryable` | Quando acontece                                                          |
| ------------ | ------------- | ------------------------------------------------------------------------ |
| `transient`  | `true`        | Rede, timeout, deadlock, broker reiniciando, pool indisponível           |
| `validation` | `false`       | SQL inválido, tabela/fila inexistente, filtro malformado, argumento ruim |
| `business`   | `false`       | Chave duplicada, violação de integridade, mensagem não roteada           |
| `permission` | `false`       | Credencial inválida ou usuário sem privilégio no backend                 |

Exceções não tratadas também viram esse envelope: nenhum stack trace vaza para o
agente. O campo `isError` do resultado MCP espelha o `isError` do envelope.

**Exemplo de sucesso:**

```json
{
  "isError": false,
  "errorCategory": null,
  "isRetryable": null,
  "message": "Statement \"SELECT\" executed, 2 row(s) affected",
  "userFriendlyMessage": "Consulta executada com sucesso (2 linha(s) retornada(s)).",
  "data": { "command": "SELECT", "rowCount": 2, "rows": [] }
}
```

**Exemplo de erro:**

```json
{
  "isError": true,
  "errorCategory": "business",
  "isRetryable": false,
  "message": "POSTGRES_QUERY: duplicate key value violates unique constraint",
  "userFriendlyMessage": "Já existe um registro com essa chave única.",
  "data": { "sqlState": "23505", "constraint": "users_email_key" }
}
```

> Uma observação: se o agente enviar argumentos que não batem com o
> `inputSchema` da tool, quem rejeita é o SDK do MCP, antes do handler rodar.
> Nesse caso a resposta é um `CallToolResult` com `isError: true` e a mensagem de
> validação do SDK — sem o envelope. Toda validação semântica (SQL vazio, filtro
> sem operador, fila inexistente) acontece dentro do handler e **usa** o envelope,
> com `errorCategory: "validation"`.

---

## Ferramentas disponíveis

### Gateway

| Tool                     | O que faz                                                                   |
| ------------------------ | --------------------------------------------------------------------------- |
| `CHECK_PROVIDERS_STATUS` | Ping real em cada provider, com latência, versão e detalhes. Aceita filtro. |

### PostgreSQL (dados sim, estrutura não)

| Tool             | O que faz                                                                  |
| ---------------- | -------------------------------------------------------------------------- |
| `QUERY`          | Executa UMA instrução de dados com placeholders `$1, $2, ...`.             |
| `LIST_TABLES`    | Lista tabelas e views, com schema e estimativa de linhas.                  |
| `DESCRIBE_TABLE` | Colunas, tipos, nulidade, defaults, chave primária e índices.              |
| `TRANSACTION`    | Várias instruções num único BEGIN/COMMIT, com ROLLBACK automático em erro. |

O resultado de `QUERY` é truncado em `DEFAULT_ROW_LIMIT` e o envelope informa
`truncated`, `returnedRows` e `totalRows`.

#### A estrutura do banco é intocável

`QUERY` e `TRANSACTION` passam por uma allowlist de comandos antes de qualquer
coisa chegar ao banco. Só passam:

```
SELECT · INSERT · UPDATE · DELETE · WITH · VALUES · TABLE · SHOW · EXPLAIN
```

Qualquer outro comando é recusado com `errorCategory: "validation"` — `CREATE`,
`ALTER`, `DROP`, `TRUNCATE`, `GRANT`, `REVOKE`, `COMMENT`, `REINDEX`, `VACUUM`,
`COPY`, `LOCK`, `DO`, `CALL`, `SET` e também comandos desconhecidos, que falham
fechado em vez de passar batido.

A validação cobre as formas menos óbvias de alterar estrutura:

- **Várias instruções numa string só.** `UPDATE t SET a = 1; DROP TABLE outra`
  é recusado: `QUERY` aceita um comando por chamada.
- **Ponto e vírgula escondido.** O separador é procurado fora de strings,
  identificadores entre aspas, blocos `$$...$$` e comentários (inclusive
  aninhados), então `SELECT 'a'; DROP TABLE t; --'` não engana a guarda.
- **`SELECT ... INTO nova_tabela`**, que cria tabela, é recusado. `INSERT INTO`
  continua funcionando normalmente.
- **`EXPLAIN ANALYZE`**, que executa de verdade: o comando analisado também
  passa pela allowlist, barrando `EXPLAIN ANALYZE CREATE TABLE ... AS SELECT`.

Numa `TRANSACTION`, a validação roda em todas as instruções **antes** do `BEGIN`:
uma instrução recusada nem chega a abrir conexão, e a mensagem diz qual delas é.

> A guarda lê o comando, não o que ele executa por dentro. Um `SELECT` que chama
> uma função com DDL no corpo (`dblink`, procedures) continua passando. Para uma
> barreira de verdade, aponte o gateway para um role sem privilégio de DDL —
> isto aqui é a rede de proteção, não o muro.

### MongoDB (leitura e escrita, sem restrição)

| Tool               | O que faz                                             |
| ------------------ | ----------------------------------------------------- |
| `LIST_DATABASES`   | Bancos acessíveis pelo usuário da conexão.            |
| `LIST_COLLECTIONS` | Coleções e views de um banco.                         |
| `FIND`             | Busca com filtro, projeção, ordenação, limite e skip. |
| `AGGREGATE`        | Pipeline de agregação (inclusive `$out` / `$merge`).  |
| `COUNT`            | Contagem de documentos por filtro.                    |
| `INSERT`           | Insere um ou mais documentos e devolve os `_id`.      |
| `UPDATE`           | `updateOne`/`updateMany` com `upsert` opcional.       |
| `DELETE`           | `deleteOne`/`deleteMany`.                             |

Filtros e documentos aceitam **Extended JSON**, então o agente trabalha só com
JSON e ainda alcança tipos BSON:

```json
{ "_id": { "$oid": "65f1c2d3e4f5a6b7c8d9e0f1" }, "criadoEm": { "$date": "2024-01-01T00:00:00Z" } }
```

Os documentos voltam no mesmo formato, prontos para serem reusados num filtro.

Duas travas de segurança embutidas:

- `UPDATE` recusa um `update` sem operador (`$set`, `$inc`, ...), evitando a
  substituição acidental do documento inteiro.
- `DELETE` com filtro vazio e `multi: true` exige `confirmDeleteAll: true`.

Funciona igual com instância própria (`mongodb://`) e com o Atlas
(`mongodb+srv://`) — basta a URL de conexão.

### RabbitMQ (apenas publicação e consulta)

| Tool                  | O que faz                                                            |
| --------------------- | -------------------------------------------------------------------- |
| `PUBLISH_TO_QUEUE`    | Publica direto em uma fila existente, com publisher confirms.        |
| `PUBLISH_TO_EXCHANGE` | Publica em uma exchange com routing key, com confirms e `mandatory`. |
| `INSPECT_QUEUE`       | Mensagens pendentes e consumidores conectados na fila.               |
| `PEEK_MESSAGES`       | Lê mensagens paradas sem consumir: tudo volta ao broker.             |
| `CHECK_EXCHANGE`      | Verifica se a exchange existe.                                       |

**O gateway nunca altera a topologia do broker.** Não existe tool para declarar,
deletar ou purgar fila, criar/remover exchange, criar bindings ou mexer em
usuários. As tools usam apenas `checkQueue` / `checkExchange`, que consultam sem
criar nada — se a fila ou exchange não existir, a resposta vem com
`errorCategory: "validation"`.

#### `PEEK_MESSAGES`: ler sem consumir

Lê até `count` mensagens (padrão 5, teto 50) com `basic.get` e devolve todas ao
broker com `nack(requeue)`. Nenhuma mensagem é perdida. O corpo volta decodificado
como JSON, texto ou base64, conforme o `contentType`, truncado em `maxBodyBytes`.

As mensagens só são recusadas depois que todas foram lidas — devolver uma por vez
faria a leitura seguinte trazer a mesma mensagem de novo — e o requeue é feito na
ordem inversa, porque cada mensagem volta para a cabeça da fila.

Dois efeitos que valem saber antes de usar em produção:

- as mensagens lidas passam a ficar marcadas como `redelivered`, o que pode
  disparar políticas de dead-letter baseadas em contagem de entregas;
- mensagens já entregues a um consumidor ativo não aparecem, porque estão
  reservadas para aquele consumidor até o ack.

#### O que o AMQP não entrega

O protocolo AMQP 0-9-1 não tem comando para **listar** nada. Não existe e não
vai existir aqui: listar filas, listar exchanges, ver bindings, ver detalhes de
consumidores ou taxas de mensagem por segundo são operações do plano de
gerenciamento (Management HTTP API, porta 15672), não do protocolo.

Sobre uma fila, o AMQP expõe exatamente três coisas: o nome, a contagem de
mensagens e a contagem de consumidores — que é o que `INSPECT_QUEUE` devolve.
Sobre uma exchange, apenas se ela existe. Durabilidade, argumentos, tipo,
política e DLQ configurada não trafegam por AMQP.

Por decisão de projeto, o gateway fala só AMQP: não abre conexão HTTP com o
broker nem depende do plugin de management estar habilitado.

Detalhes das publicações:

- Sempre com **publisher confirms**: o sucesso só é reportado depois do broker
  confirmar a gravação (com teto de `RABBITMQ_PUBLISH_TIMEOUT_MS`).
- Sempre com **`mandatory`**: se nenhuma fila receber a mensagem publicada numa
  exchange, a resposta vem com `errorCategory: "business"` e `routed: false`, em
  vez de sumir silenciosamente.
- Objetos e arrays são serializados como JSON (`application/json`); strings vão
  como `text/plain`. Dá para sobrescrever com `contentType`.
- Opções AMQP suportadas: `persistent` (padrão `true`), `headers`,
  `correlationId`, `messageId`, `replyTo`, `priority`, `expirationMs`, `type`.

> Contagem de filas e consumidores vem do próprio AMQP. Listar **todas** as filas
> do broker exigiria a HTTP Management API, que não é usada aqui.

---

## Configuração (variáveis de ambiente)

Copie `.env.example` para `.env` e ajuste. Nenhuma variável é obrigatória: o
gateway sobe com os padrões e sem provider algum.

| Variável                            | Padrão        | Descrição                                                    |
| ----------------------------------- | ------------- | ------------------------------------------------------------ |
| `PORT`                              | `3000`        | Porta HTTP.                                                  |
| `HOST`                              | `0.0.0.0`     | Interface de escuta.                                         |
| `GATEWAY_NAME`                      | `MCP_GATEWAY` | Prefixo de todas as tools.                                   |
| `MCP_PATH`                          | `/mcp`        | Caminho do endpoint MCP.                                     |
| `LOG_LEVEL`                         | `info`        | `debug`, `info`, `warn`, `error`, `silent`.                  |
| `REQUEST_BODY_LIMIT`                | `4mb`         | Tamanho máximo do corpo das requisições.                     |
| `POSTGRES_CONNECTION_URL`           | —             | Ativa o provider PostgreSQL.                                 |
| `POSTGRES_POOL_MAX`                 | `10`          | Conexões máximas no pool.                                    |
| `POSTGRES_CONNECTION_TIMEOUT_MS`    | `10000`       | Timeout para obter conexão do pool.                          |
| `POSTGRES_STATEMENT_TIMEOUT_MS`     | `30000`       | Timeout por instrução.                                       |
| `MONGO_CONNECTION_URL`              | —             | Ativa o provider MongoDB (`mongodb://` ou `mongodb+srv://`). |
| `MONGO_DEFAULT_DATABASE`            | banco da URL  | Banco usado quando a tool não recebe `database`.             |
| `MONGO_SERVER_SELECTION_TIMEOUT_MS` | `10000`       | Timeout de seleção de servidor.                              |
| `MONGO_MAX_POOL_SIZE`               | `10`          | Conexões máximas no pool.                                    |
| `RABBITMQ_CONNECTION_URL`           | —             | Ativa o provider RabbitMQ (`amqp://` ou `amqps://`).         |
| `RABBITMQ_CONNECTION_TIMEOUT_MS`    | `10000`       | Timeout de conexão AMQP.                                     |
| `RABBITMQ_PUBLISH_TIMEOUT_MS`       | `10000`       | Teto de espera pelo publisher confirm.                       |
| `DEFAULT_ROW_LIMIT`                 | `100`         | Linhas/documentos devolvidos sem limite explícito.           |
| `MAX_ROW_LIMIT`                     | `1000`        | Teto que a chamada pode pedir.                               |

As URLs de conexão também são lidas de nomes alternativos, para conviver com
deploys já existentes:

- PostgreSQL: `POSTGRES_CONNECTION_URL`, `POSTGRESS_CONNECTION_URL`,
  `POSTGRES_CONECTION_URL`, `POSTGRESS_CONECTION_URL`, `DATABASE_URL`
- MongoDB: `MONGO_CONNECTION_URL`, `MONGODB_CONNECTION_URL`,
  `MONGO_CONECTION_URL`, `MONGODB_URI`
- RabbitMQ: `RABBITMQ_CONNECTION_URL`, `RABBIT_CONNECTION_URL`,
  `RABBITMQ_CONECTION_URL`, `RABBIT_CONECTION_URL`, `AMQP_URL`

Uma URL com protocolo incompatível (ex.: `mysql://` no PostgreSQL) derruba o
processo no boot com mensagem explicando o campo — falha cedo, em vez de só na
primeira chamada da tool.

---

## Executando com Docker

### Só o gateway, apontando para a infra que você já tem

```bash
docker build -t mcp-gateway .

docker run -d --name mcp-gateway -p 3000:3000 \
  -e GATEWAY_NAME=ACME \
  -e POSTGRES_CONNECTION_URL="postgres://user:senha@host:5432/app" \
  -e MONGO_CONNECTION_URL="mongodb+srv://user:senha@cluster0.abc.mongodb.net/app" \
  -e RABBITMQ_CONNECTION_URL="amqp://user:senha@host:5672" \
  mcp-gateway
```

### Stack completa para desenvolvimento

Sobe gateway + PostgreSQL + MongoDB + RabbitMQ, cada backend com healthcheck:

```bash
docker compose up -d
docker compose logs -f mcp-gateway
```

A imagem roda como usuário `node` (sem root) e traz um `HEALTHCHECK` que consulta
o `/health` — o container fica `unhealthy` quando um provider configurado cai.

---

## Desenvolvimento local

```bash
npm install
cp .env.example .env    # ajuste as URLs

npm run dev             # tsx watch, recarrega a cada alteração
npm run build           # compila para dist/
npm start               # roda o build

npm test                # jest
npm run test:coverage   # jest com cobertura
npm run lint            # eslint
npm run format          # prettier --write
npm run typecheck       # tsc --noEmit
npm run check           # typecheck + lint + test
```

---

## Conectando um agente

Qualquer cliente MCP que fale **Streamable HTTP** serve. Exemplo de configuração:

```json
{
  "mcpServers": {
    "acme-gateway": {
      "type": "http",
      "url": "http://localhost:3000/mcp"
    }
  }
}
```

Teste rápido por linha de comando:

```bash
curl -X POST http://localhost:3000/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

---

## Endpoints HTTP

| Método | Rota      | Resposta                                                             |
| ------ | --------- | -------------------------------------------------------------------- |
| `POST` | `/mcp`    | Endpoint MCP (Streamable HTTP, stateless).                           |
| `GET`  | `/mcp`    | `405` — não há stream de servidor sem sessão.                        |
| `GET`  | `/health` | `200` com todos saudáveis, `503` se algum provider configurado caiu. |
| `GET`  | `/`       | Nome do gateway, endpoint MCP, prefixo e lista de tools registradas. |

---

## Arquitetura

```
src/
├── index.ts                  # boot, conexão dos providers, shutdown gracioso
├── config/
│   └── env.ts                # leitura e validação do ambiente (zod)
├── core/
│   ├── tool-response.ts      # o contrato ToolResponse e suas fábricas
│   ├── errors.ts             # ToolError e classificação genérica
│   ├── tool-name.ts          # {GATEWAY}_{PROVIDER}_{TOOL}
│   ├── tool-registrar.ts     # aplica nome + envelope em todas as tools
│   ├── serialization.ts      # JSON seguro (BigInt, Buffer, ciclos, ...)
│   └── logger.ts             # log estruturado em JSON
├── providers/
│   ├── index.ts              # contrato Provider + BaseProvider/ConnectedProvider/ProviderErrorMapper
│   ├── PostgresProvider.ts   # provider + SqlGuard + PostgresErrorMapper
│   ├── MongoProvider.ts      # provider + ExtendedJson + MongoErrorMapper
│   └── RabbitMqProvider.ts   # provider + AmqpMessageCodec + RabbitMqErrorMapper
├── server/
│   ├── mcp-server.ts         # monta o McpServer e registra as tools
│   └── http.ts               # Express: /mcp, /health, /
├── testing/
│   └── fake-mcp-server.ts    # duplo de McpServer usado pelos testes
└── tools/
    └── check-providers-status.tool.ts
```

### Onde ficam os testes

Cada teste unitário mora ao lado do arquivo que exercita, com o sufixo
`.unit.spec.ts`:

```
src/core/tool-registrar.ts
src/core/tool-registrar.unit.spec.ts
src/providers/PostgresProvider.ts
src/providers/PostgresProvider.unit.spec.ts
```

Assim o teste aparece junto do código no editor e acompanha o arquivo quando ele
muda de lugar. O `jest.config.js` procura por `**/*.unit.spec.ts` dentro de
`src/`, e o `tsconfig.build.json` exclui esses arquivos junto com `src/testing/`,
então nada de teste chega ao `dist/` nem à imagem Docker.

O sufixo deixa espaço para outros níveis mais tarde (`.int.spec.ts`,
`.e2e.spec.ts`) rodarem com configuração própria, sem tocar nestes.

Dois pontos centrais sustentam as garantias do projeto:

- **`ToolRegistrar`** é o único caminho para registrar uma tool. Ele aplica o
  padrão de nome, anuncia o `outputSchema` e envolve o handler num try/catch que
  converte qualquer exceção no envelope. Nenhuma tool consegue fugir do contrato.
- **`Provider`** é a interface que todo backend implementa (`connect`,
  `disconnect`, `checkHealth`, `registerTools`), o que mantém a tool de status e o
  `/health` funcionando igual para todos, atuais e futuros. `BaseProvider` e
  `ConnectedProvider` (em `src/providers/index.ts`) já entregam essa interface
  pronta: identidade, logger etiquetado, ciclo de vida da conexão com abertura
  única sob concorrência e o fluxo de health check. A subclasse preenche só o que
  é do backend — `connectionUrl`, `openConnection`, `closeConnection`, `probe` e
  `defineTools`.

---

## Adicionando um novo provider

Cada backend é uma fatia vertical: **um arquivo** em `src/providers/` com tudo
que é dele (provider, tradutor de erros e o que mais for específico), mais o
`.unit.spec.ts` ao lado.

1. Crie `src/providers/<Nome>Provider.ts` com uma classe que estenda
   `ConnectedProvider<TConexao>` (ou `BaseProvider`, se não houver conexão viva),
   implementando `connectionUrl`, `openConnection`, `closeConnection`, `probe` e
   `defineTools`.
2. No mesmo arquivo, crie `<Nome>ErrorMapper extends ProviderErrorMapper`
   mapeando os erros do driver para as quatro categorias — a cascata
   (classificação → falha de rede → erro de negócio) já vem da classe-base.
3. Declare as tools em `defineTools(registrar)` com `this.tool(registrar, {...})`
   — o segmento do provider, o nome completo e o envelope saem de graça.
4. Adicione a URL de conexão em `src/config/env.ts` e devolva-a em
   `connectionUrl`, para o provider continuar sendo opcional.
5. Instancie o provider na lista de `src/index.ts`.

> `src/providers/index.ts` guarda só o contrato e as classes-base; ele **não**
> reexporta os providers concretos, porque isso criaria um ciclo em tempo de
> execução com as subclasses. Importe cada provider pelo arquivo dele.
