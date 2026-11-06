# dsh-tool-search

English | [Português](README.pt-BR.md)

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) plugin that keeps large tool sets, such as many MCP servers, out of every model request. Tool definitions are loaded on demand with a `tool_search` tool.

With many MCP servers configured, every request carried hundreds of definitions the agent never used. In one measured native desktop session, 480 tools weighed 396 KB of JSON per request, and 352 KB of that was MCP definitions. With this plugin the model sees a short list of tool groups plus `tool_search`, and the tools it loads are declared from its next step.

Deferred tools stay registered and executable. Only the declaration size of each request changes. Deferral is presentation, not access control; use the harness's own tool restrictions to forbid a tool.

## Install

The module has no package imports and reads everything from the Cordis `ctx`, so one file mounts by absolute path. Add a row to your profile patch (`cordis.patch.yml`):

```yaml
- insert:
    - id: tool-search
      name: 'C:/path/to/dsh-tool-search/index.mjs'
      config:
        defer:
          - 'mcp__*'
        keep:
          - 'mcp__memory__*'
        maxResults: 8
```

The host caches plugin modules, so restart it after you change the file. Removing the row restores the full declarations.

| Field | Default | Meaning |
|---|---|---|
| `defer` | required | `*`-wildcard patterns over complete tool names. Matching tools are withheld until loaded. |
| `keep` | `[]` | Patterns that are never withheld, even when `defer` matches. |
| `maxResults` | `8` | Most tools one keyword search loads. |

An empty `defer` list, an empty pattern, or a non-positive `maxResults` fails when the plugin loads.

## How it works

The model calls `tool_search` with `query` keywords, exact `names`, or both. Keyword search ranks unloaded deferred tools by how many query terms their names and descriptions contain (name hits count more) and loads the best `maxResults`. A name that no pattern defers is reported as already loaded; an unknown name is reported as unknown.

- **Native mode.** The plugin removes deferred entries from the tools of `system-prompt/assemble` and adds a catalog section that lists each deferred group once with its tool count.
- **PTC mode.** The plugin rewrites the generated `tools:sdk` section, removing deferred members from `ToolArgsMap` and `ToolOutputMap`. The model calls `await tools.tool_search({ query })` inside `run_code`. A layout it does not recognize is left unfiltered, with one warning in the log.
- **Per agent.** Loading is per agent. A subagent starts with nothing loaded. A resumed native session keeps the tools its last logged request header declared, provided that header already declared `tool_search`. A resumed PTC session starts empty.

## Compatibility

Verified on DeepSeek Harness 0.2.1-alpha.2. Newer releases moved tool declarations out of the `system-prompt/assemble` assembly into the provider. On such a release native deferral is inactive: the plugin leaves the assembly untouched and logs one warning (`native deferral is inactive`) instead of failing prompt assembly. The PTC filter depends on the member layout that the SDK generator emits.

## Known limits

- Deferral hides declarations only. A model that guesses an unloaded tool name can still call it.
- Loaded tools are never unloaded within a session.
- Keyword ranking is plain term containment, with no stemming or synonyms.
- Loading a tool changes the tool list (native) or the SDK text (PTC), so the cached request prefix after that point is rewritten on the next request. Loading related tools in one search limits the rewrites.
- In PTC mode `tool_search` runs inside `run_code`, which costs one program per search.

## Test

```sh
npm test
```

The tests use a fake Cordis context and need neither DeepSeek Harness nor any dependency.

## License

MIT
