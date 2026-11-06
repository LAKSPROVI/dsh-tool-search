/**
 * dsh-tool-search — on-demand tool loading for large MCP tool sets.
 *
 * Tools whose names match `defer` leave the model's tool declarations until the
 * agent loads them with `tool_search`; they stay registered and executable, so
 * only the per-request declaration size changes. Deferral is presentation, not
 * access control. Works with native tool declarations and with the generated
 * `run_code` SDK of PTC mode (the plugin rewrites the `tools:sdk` section).
 *
 * The module has no package imports: it reads every host capability from the
 * Cordis `ctx` it receives, so this one file mounts on any DSH profile by
 * absolute path. It targets DSH releases whose `system-prompt/assemble`
 * assembly still carries `tools` (verified on 0.2.1-alpha.2). On a release
 * that moved tool declarations out of the assembly, native deferral is
 * inactive and the plugin logs one warning instead of failing prompt assembly.
 *
 * Config (all under the plugin row's `config`):
 *   defer       required; `*`-wildcard patterns over complete tool names.
 *   keep        optional; patterns never deferred, overriding `defer`.
 *   maxResults  optional; most tools one keyword search loads (default 8).
 */

/** Cordis plugin name. */
export const name = 'tool-search'

/** Services required before `apply` runs. */
export const inject = ['tools', 'systemPrompt']

/** Model-facing name of the loading tool; never deferred itself. */
export const TOOL_SEARCH_NAME = 'tool_search'

const CATALOG_SECTION = 'tool-search:catalog'
const SDK_SECTION = 'tools:sdk'
const RESULT_DESCRIPTION_LIMIT = 200
const DEFAULT_MAX_RESULTS = 8
const NAME_TERM_SCORE = 3
const DESCRIPTION_TERM_SCORE = 1
const TERM_SEPARATOR = /[^\p{L}\p{N}]+/u
const SDK_MAPS = ['ToolArgsMap', 'ToolOutputMap']
const SDK_MEMBER_KEY = /^ {2}([A-Za-z_$][\w$]*|"(?:[^"\\]|\\.)*"):/

/**
 * Compile a `*`-wildcard pattern to a whole-name predicate.
 *
 * @param pattern - tool name where `*` matches any run of characters.
 * @returns a predicate over complete tool names.
 */
export function compileGlob(pattern) {
  const source = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')
  const expression = new RegExp(`^${source}$`, 'su')
  return toolName => expression.test(toolName)
}

/**
 * Order names by UTF-16 code unit so ranking and the catalog do not depend on locale.
 *
 * @param a - first name.
 * @param b - second name.
 * @returns a negative, zero, or positive number as for `Array.prototype.sort`.
 */
export function compareNames(a, b) {
  return Number(a > b) - Number(a < b)
}

/**
 * Split a free-text query into distinct lowercase search terms.
 *
 * @param query - the model's keywords.
 * @returns terms in first-seen order.
 */
export function queryTerms(query) {
  return [...new Set(query.toLowerCase().split(TERM_SEPARATOR).filter(term => term !== ''))]
}

/**
 * Rank tools by how many query terms their name and description contain.
 *
 * @param tools - candidate `{ name, description }` entries.
 * @param terms - lowercase terms from {@link queryTerms}.
 * @returns tools with a positive score, best first; ties sort by name.
 */
export function rankTools(tools, terms) {
  const ranked = []
  for (const tool of tools) {
    const toolName = tool.name.toLowerCase()
    const description = tool.description.toLowerCase()
    let score = 0
    for (const term of terms) {
      if (toolName.includes(term)) score += NAME_TERM_SCORE
      if (description.includes(term)) score += DESCRIPTION_TERM_SCORE
    }
    if (score > 0) ranked.push({ tool, score })
  }
  return ranked.sort((a, b) => b.score - a.score || compareNames(a.tool.name, b.tool.name))
}

/**
 * Display group of a tool name for the prompt catalog; display only.
 *
 * @param toolName - model-facing tool name.
 * @returns `mcp__<server>` for server-qualified names, otherwise the name.
 */
export function catalogGroup(toolName) {
  if (!toolName.startsWith('mcp__')) return toolName
  const separator = toolName.indexOf('__', 'mcp__'.length)
  return separator === -1 ? toolName : toolName.slice(0, separator)
}

/**
 * First line of a description, shortened for a search result.
 *
 * @param description - full tool description.
 * @param limit - maximum characters before an ellipsis.
 * @returns a single-line summary.
 */
export function summarize(description, limit) {
  const line = description.trim().replace(/\n[\s\S]*$/, '')
  return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
}

/** Split the lines of one SDK interface body into per-tool members, or undefined when the layout is not the generated one. */
function parseMembers(body) {
  const members = []
  let doc
  let current
  for (const line of body) {
    if (line.startsWith('  /**')) {
      doc = line
      current = undefined
      continue
    }
    const key = SDK_MEMBER_KEY.exec(line)
    if (key === null) {
      if (current === undefined) return undefined
      current.lines.push(line)
      continue
    }
    const raw = key[1]
    current = { name: raw.startsWith('"') ? JSON.parse(raw) : raw, lines: doc === undefined ? [line] : [doc, line] }
    members.push(current)
    doc = undefined
  }
  return doc === undefined ? members : undefined
}

/**
 * Remove selected tools from the generated PTC SDK section. The generator emits
 * one member per tool in `ToolArgsMap` and `ToolOutputMap`: an optional one-line
 * JSDoc, a key line, and any deeper-indented continuation lines.
 *
 * @param text - the `tools:sdk` section text.
 * @param hidden - whether to remove the member of a tool name; receives every name declared in `ToolArgsMap`.
 * @returns `{ text, declared }`, or undefined when either interface is missing or does not have the generated layout.
 */
export function filterSdk(text, hidden) {
  const lines = text.split('\n')
  const maps = new Map()
  for (let index = 0; index < lines.length; index += 1) {
    const map = SDK_MAPS.find(candidate => lines[index] === `interface ${candidate} {`)
    if (map === undefined) continue
    const end = lines.indexOf('}', index + 1)
    const members = end === -1 ? undefined : parseMembers(lines.slice(index + 1, end))
    if (members === undefined) return undefined
    maps.set(map, { start: index, end, members })
    index = end
  }
  const args = maps.get('ToolArgsMap')
  if (args === undefined || !maps.has('ToolOutputMap')) return undefined
  const declared = args.members.map(member => member.name)
  const out = []
  let cursor = 0
  for (const { start, end, members } of [...maps.values()].sort((a, b) => a.start - b.start)) {
    out.push(...lines.slice(cursor, start + 1), ...members.filter(member => !hidden(member.name, declared)).flatMap(member => member.lines))
    cursor = end
  }
  out.push(...lines.slice(cursor))
  return { text: out.join('\n'), declared }
}

/** Prompt text naming each deferred group once; independent of what is loaded so it stays cache-stable. */
function catalogText(deferredNames, inCode) {
  const counts = new Map()
  for (const toolName of deferredNames) {
    const group = catalogGroup(toolName)
    counts.set(group, (counts.get(group) ?? 0) + 1)
  }
  const groups = [...counts].sort(([a], [b]) => compareNames(a, b)).map(([group, count]) => `${group} (${count})`)
  const how = inCode
    ? `${deferredNames.length} tools are not declared in the SDK until you load them. `
      + `Inside run_code, call \`await tools.${TOOL_SEARCH_NAME}({ query })\` with keywords, or \`{ names }\` with exact names, and return or print the result; `
      + 'loaded tools are declared from your next step.'
    : `${deferredNames.length} tools are not in your tool list until you load them. `
      + `Call ${TOOL_SEARCH_NAME} with \`query\` keywords or exact \`names\`; loaded tools are callable from your next step.`
  return `## Tools loaded on demand\n\n${how}\n\nGroups (tool count): ${groups.join(', ')}.`
}

/** Render a search result for the model. */
function renderResult(value) {
  const lines = []
  if (value.loaded.length > 0) {
    lines.push(`Loaded ${value.loaded.length} tool${value.loaded.length === 1 ? '' : 's'}; callable from your next step:`)
    for (const tool of value.loaded) lines.push(`- ${tool.name}: ${tool.description}`)
  }
  if (value.alreadyLoaded.length > 0) lines.push(`Already loaded: ${value.alreadyLoaded.join(', ')}`)
  if (value.unknown.length > 0) lines.push(`Unknown names: ${value.unknown.join(', ')}`)
  if (lines.length === 0) lines.push('No unloaded tool matches. Try other keywords or exact names from the tool groups listed in the prompt.')
  return [{ type: 'text', text: lines.join('\n') }]
}

/** Validate the plugin config and return the compiled matchers; fails loud at load. */
function resolveConfig(config) {
  const defer = config?.defer
  if (!Array.isArray(defer) || defer.length === 0) {
    throw new Error('tool-search: `defer` must list at least one tool-name pattern')
  }
  const keep = config.keep ?? []
  if (!Array.isArray(keep)) throw new Error('tool-search: `keep` must be a list of tool-name patterns')
  const maxResults = config.maxResults ?? DEFAULT_MAX_RESULTS
  if (!Number.isInteger(maxResults) || maxResults < 1) {
    throw new Error('tool-search: `maxResults` must be a positive integer')
  }
  const compile = (patterns, field) => patterns.map((pattern) => {
    if (typeof pattern !== 'string' || pattern === '') {
      throw new Error(`tool-search: \`${field}\` must contain only non-empty strings`)
    }
    return compileGlob(pattern)
  })
  return { deferPatterns: compile(defer, 'defer'), keepPatterns: compile(keep, 'keep'), maxResults }
}

/**
 * Hide deferred tool declarations from each agent's requests and register `tool_search`.
 *
 * @param ctx - Cordis context carrying `tools` and `systemPrompt`.
 * @param config - deferral patterns and search size.
 */
export function apply(ctx, config) {
  const { deferPatterns, keepPatterns, maxResults } = resolveConfig(config)
  const isDeferred = toolName => toolName !== TOOL_SEARCH_NAME
    && deferPatterns.some(matches => matches(toolName))
    && !keepPatterns.some(matches => matches(toolName))

  const loadedByAgent = new WeakMap()
  /**
   * Loaded names for one agent. A native request header that already declared `tool_search` shows
   * deferral was active, so its deferred tools stay loaded after a resume; any other history starts empty.
   * PTC declarations live in the system prompt, which this plugin does not read back, so PTC starts empty.
   */
  const loadedFor = (agent) => {
    let loaded = loadedByAgent.get(agent)
    if (loaded === undefined) {
      const declared = (agent.session.requestHeader()?.tools ?? []).map(tool => tool.name)
      loaded = new Set(declared.includes(TOOL_SEARCH_NAME) ? declared.filter(isDeferred) : [])
      loadedByAgent.set(agent, loaded)
    }
    return loaded
  }

  let warnedSdkLayout = false
  let warnedNoDeclarations = false

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const accepted = await next()
    const loaded = context.agent === undefined ? new Set() : loadedFor(context.agent)
    const sdk = accepted.sections.find(section => section.name === SDK_SECTION)
    if (sdk !== undefined) {
      // PTC mode: the model sees one `run_code` declaration and the tools only in the SDK text.
      const filtered = filterSdk(sdk.text, (toolName, declared) => toolName === TOOL_SEARCH_NAME
        ? !declared.some(isDeferred)
        : isDeferred(toolName) && !loaded.has(toolName))
      if (filtered === undefined) {
        if (!warnedSdkLayout) ctx.logger.warn('tool-search: the tools:sdk section has an unrecognized layout; leaving it unfiltered')
        warnedSdkLayout = true
        return accepted
      }
      const deferredNames = filtered.declared.filter(isDeferred)
      return {
        ...accepted,
        sections: [
          ...accepted.sections.map(section => section === sdk ? { ...section, text: filtered.text } : section),
          ...deferredNames.length === 0 ? [] : [{ name: CATALOG_SECTION, text: catalogText(deferredNames, true), interpolate: false }],
        ],
      }
    }
    if (!Array.isArray(accepted.tools)) {
      // Newer DSH releases declare tools through the provider, not through this assembly.
      if (!warnedNoDeclarations) {
        ctx.logger.warn('tool-search: this DSH release does not expose tool declarations in system-prompt/assemble; native deferral is inactive')
      }
      warnedNoDeclarations = true
      return accepted
    }
    const deferredNames = accepted.tools.map(tool => tool.name).filter(isDeferred)
    if (deferredNames.length === 0) {
      return { ...accepted, tools: accepted.tools.filter(tool => tool.name !== TOOL_SEARCH_NAME) }
    }
    return {
      ...accepted,
      sections: [...accepted.sections, { name: CATALOG_SECTION, text: catalogText(deferredNames, false), interpolate: false }],
      tools: accepted.tools.filter(tool => !isDeferred(tool.name) || loaded.has(tool.name)),
    }
  })

  ctx.effect(() => ctx.tools.register({
    name: TOOL_SEARCH_NAME,
    description: 'Load tools that are not yet in your tool list. Pass `query` keywords to load the best matches, '
      + 'or `names` to load exact tools. Loaded tools are callable from your next step.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keywords describing the capability you need.' },
        names: { type: 'array', items: { type: 'string' }, description: 'Exact tool names to load.' },
      },
      additionalProperties: false,
    },
    output: {
      schema: {
        type: 'object',
        properties: {
          loaded: {
            type: 'array',
            items: {
              type: 'object',
              properties: { name: { type: 'string' }, description: { type: 'string' } },
              required: ['name', 'description'],
              additionalProperties: false,
            },
          },
          alreadyLoaded: { type: 'array', items: { type: 'string' } },
          unknown: { type: 'array', items: { type: 'string' } },
        },
        required: ['loaded', 'alreadyLoaded', 'unknown'],
        additionalProperties: false,
      },
      render: (_args, value) => renderResult(value),
    },
    execute: (args, exec) => {
      const agent = exec.agent
      if (agent === undefined) throw new Error(`${TOOL_SEARCH_NAME} requires an agent`)
      const query = args?.query
      const requested = args?.names ?? []
      if (query !== undefined && typeof query !== 'string') throw new Error(`${TOOL_SEARCH_NAME}: \`query\` must be a string`)
      if (!Array.isArray(requested) || requested.some(item => typeof item !== 'string')) {
        throw new Error(`${TOOL_SEARCH_NAME}: \`names\` must be a list of strings`)
      }
      if (query === undefined && requested.length === 0) {
        throw new Error(`${TOOL_SEARCH_NAME} needs \`query\` keywords or \`names\``)
      }
      const visible = ctx.tools.schemas(agent)
      const candidates = visible.filter(tool => isDeferred(tool.name))
      const byName = new Map(candidates.map(tool => [tool.name, tool]))
      const declared = new Set(visible.map(tool => tool.name))
      const loaded = loadedFor(agent)
      const result = { loaded: [], alreadyLoaded: [], unknown: [] }
      const load = (tool) => {
        loaded.add(tool.name)
        result.loaded.push({ name: tool.name, description: summarize(tool.description, RESULT_DESCRIPTION_LIMIT) })
      }
      for (const requestedName of requested) {
        const tool = byName.get(requestedName)
        // A tool no pattern defers is always declared, so naming it is not an error.
        if (tool === undefined) (declared.has(requestedName) ? result.alreadyLoaded : result.unknown).push(requestedName)
        else if (loaded.has(requestedName)) result.alreadyLoaded.push(requestedName)
        else load(tool)
      }
      if (query !== undefined) {
        const unloaded = candidates.filter(tool => !loaded.has(tool.name))
        for (const { tool } of rankTools(unloaded, queryTerms(query)).slice(0, maxResults)) load(tool)
      }
      return Promise.resolve(result)
    },
  }), 'tool-search.tool')
  ctx.logger.info(`tool-search: active (defer=${deferPatterns.length} patterns, keep=${keepPatterns.length}, maxResults=${maxResults})`)
}
