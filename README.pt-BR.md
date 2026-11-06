# dsh-tool-search

[English](README.md) | Português

Plugin do [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) que tira conjuntos grandes de ferramentas, como muitos servidores MCP, de cada requisição ao modelo. As definições são carregadas sob demanda pela ferramenta `tool_search`.

Com muitos servidores MCP configurados, cada requisição levava centenas de definições que o agente nunca usava. Numa sessão nativa do desktop medida, 480 ferramentas pesavam 396 KB de JSON por requisição, e 352 KB eram definições de MCP. Com o plugin, o modelo vê uma lista curta de grupos de ferramentas e o `tool_search`; as ferramentas que ele carrega são declaradas a partir do passo seguinte.

As ferramentas adiadas continuam registradas e executáveis. Só muda o tamanho da declaração em cada requisição. O adiamento é apresentação, não controle de acesso; para proibir uma ferramenta use as restrições do próprio harness.

## Instalação

O módulo não importa pacotes e lê tudo do `ctx` do Cordis, então um único arquivo é montado por caminho absoluto. Acrescente uma linha ao patch do perfil (`cordis.patch.yml`):

```yaml
- insert:
    - id: tool-search
      name: 'C:/caminho/para/dsh-tool-search/index.mjs'
      config:
        defer:
          - 'mcp__*'
        keep:
          - 'mcp__memory__*'
        maxResults: 8
```

O host guarda os módulos de plugin em cache: reinicie-o depois de mudar o arquivo. Remover a linha restaura as declarações completas.

| Campo | Padrão | Significado |
|---|---|---|
| `defer` | obrigatório | Padrões com `*` sobre o nome completo da ferramenta. As que casam ficam retidas até serem carregadas. |
| `keep` | `[]` | Padrões que nunca são retidos, mesmo quando `defer` casa. |
| `maxResults` | `8` | Máximo de ferramentas que uma busca por palavras-chave carrega. |

Lista `defer` vazia, padrão vazio ou `maxResults` não positivo falham na carga do plugin.

## Como funciona

O modelo chama `tool_search` com palavras em `query`, `names` exatos, ou os dois. A busca ordena as ferramentas adiadas ainda não carregadas pelo número de termos que o nome e a descrição contêm (acerto no nome pesa mais) e carrega as `maxResults` melhores. Nome que nenhum padrão adia é informado como já carregado; nome desconhecido é informado como desconhecido.

- **Modo nativo.** O plugin remove as ferramentas adiadas das `tools` de `system-prompt/assemble` e acrescenta uma seção de catálogo com cada grupo adiado e sua contagem.
- **Modo PTC.** O plugin reescreve a seção `tools:sdk` gerada, removendo os membros adiados de `ToolArgsMap` e `ToolOutputMap`. O modelo chama `await tools.tool_search({ query })` dentro do `run_code`. Um layout que o plugin não reconhece fica sem filtro, com um aviso no log.
- **Por agente.** O carregamento é por agente. Um subagente começa sem nada carregado. Uma sessão nativa retomada mantém as ferramentas do último cabeçalho de requisição registrado, desde que esse cabeçalho já declarasse `tool_search`. Uma sessão PTC retomada começa vazia.

## Compatibilidade

Verificado no DeepSeek Harness 0.2.1-alpha.2. Versões mais novas tiraram as declarações de ferramentas da montagem de `system-prompt/assemble` e as passaram ao provedor. Nessas versões o adiamento nativo fica inativo: o plugin deixa a montagem intacta e registra um aviso (`native deferral is inactive`), em vez de quebrar a montagem do prompt. O filtro PTC depende do layout de membros que o gerador do SDK emite.

## Limites conhecidos

- O adiamento só esconde declarações. Um modelo que adivinhe o nome de uma ferramenta não carregada ainda pode chamá-la.
- Ferramentas carregadas nunca são descarregadas na mesma sessão.
- A ordenação por palavras-chave é contenção simples de termos, sem radicais nem sinônimos.
- Carregar uma ferramenta muda a lista de ferramentas (nativo) ou o texto do SDK (PTC); o prefixo em cache depois desse ponto é reescrito na requisição seguinte. Carregar ferramentas relacionadas numa só busca reduz as reescritas.
- No modo PTC o `tool_search` roda dentro do `run_code`, o que custa um programa por busca.

## Teste

```sh
npm test
```

Os testes usam um contexto Cordis falso e não precisam do DeepSeek Harness nem de dependências.

## Licença

MIT
