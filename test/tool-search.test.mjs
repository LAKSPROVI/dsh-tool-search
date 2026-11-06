import test from 'node:test'
import assert from 'node:assert/strict'
import * as plugin from '../index.mjs'

const MCP_TOOLS = [
  { name: 'mcp__docs__search', description: 'Search documents by topic.\nSecond line is hidden.' },
  { name: 'mcp__docs__read', description: 'Read one document.' },
  { name: 'mcp__mail__send', description: 'Send a mail message.' },
  { name: 'mcp__mail__list', description: 'List mail messages.' },
  { name: 'read', description: 'Read a file.' },
]

/** Fake Cordis context: captures the assemble listener and the registered tool. */
function setup(config, { tools = MCP_TOOLS } = {}) {
  const handlers = new Map()
  const registered = new Map()
  const logs = { info: [], warn: [] }
  const ctx = {
    on: (event, handler) => { handlers.set(event, handler) },
    effect: (factory) => { factory() },
    logger: { info: message => logs.info.push(message), warn: message => logs.warn.push(message) },
    tools: {
      register: (definition) => { registered.set(definition.name, definition) },
      schemas: () => [...tools, ...registered.values()].map(({ name, description }) => ({ name, description })),
    },
  }
  plugin.apply(ctx, { defer: ['mcp__*'], ...config })
  const agent = () => ({ session: { requestHeader: () => undefined } })
  const assemble = (accepted, agentValue) => handlers.get('system-prompt/assemble')(
    undefined,
    { agent: agentValue },
    () => Promise.resolve(accepted),
  )
  const nativeAssembly = () => ({ sections: [], tools: [...tools, { name: plugin.TOOL_SEARCH_NAME, description: 'x' }] })
  const search = (args, agentValue) => registered.get(plugin.TOOL_SEARCH_NAME).execute(args, { agent: agentValue })
  return { agent, assemble, nativeAssembly, search, logs, registered }
}

const names = assembly => assembly.tools.map(tool => tool.name).sort()

test('withholds deferred tools, keeps the rest, and lists groups once', async () => {
  const { agent, assemble, nativeAssembly } = setup()
  const result = await assemble(nativeAssembly(), agent())
  assert.deepEqual(names(result), ['read', 'tool_search'])
  const catalog = result.sections.find(section => section.name === 'tool-search:catalog')
  assert.match(catalog.text, /4 tools are not in your tool list/)
  assert.match(catalog.text, /Groups \(tool count\): mcp__docs \(2\), mcp__mail \(2\)\./)
})

test('keep overrides defer', async () => {
  const { agent, assemble, nativeAssembly } = setup({ keep: ['mcp__mail__send'] })
  assert.deepEqual(names(await assemble(nativeAssembly(), agent())), ['mcp__mail__send', 'read', 'tool_search'])
})

test('a keyword search loads the best matches only for the calling agent', async () => {
  const { agent, assemble, nativeAssembly, search } = setup({ maxResults: 1 })
  const caller = agent()
  const other = agent()
  const result = await search({ query: 'mail send' }, caller)
  assert.equal(result.loaded.length, 1)
  assert.equal(result.loaded[0].name, 'mcp__mail__send')
  assert.deepEqual(names(await assemble(nativeAssembly(), caller)), ['mcp__mail__send', 'read', 'tool_search'])
  assert.deepEqual(names(await assemble(nativeAssembly(), other)), ['read', 'tool_search'])
})

test('exact names load, repeat as already loaded, and unknown names are reported', async () => {
  const { agent, search } = setup()
  const caller = agent()
  await search({ names: ['mcp__docs__read'] }, caller)
  const result = await search({ names: ['mcp__docs__read', 'mcp__missing__tool', 'read'] }, caller)
  assert.deepEqual(result, { loaded: [], alreadyLoaded: ['mcp__docs__read', 'read'], unknown: ['mcp__missing__tool'] })
})

test('a call that names nothing, or has no agent, fails', () => {
  const { agent, search } = setup()
  assert.throws(() => search({}, agent()), /needs `query` keywords or `names`/)
  assert.throws(() => search({ query: 'mail' }, undefined), /requires an agent/)
})

test('removes tool_search from the request when nothing is deferred', async () => {
  const { agent, assemble, nativeAssembly } = setup({ defer: ['nothing__*'] })
  assert.deepEqual(names(await assemble(nativeAssembly(), agent())), [...MCP_TOOLS.map(tool => tool.name)].sort())
})

test('a release without tools in the assembly is left untouched and warned about once', async () => {
  const { agent, assemble, logs } = setup()
  const accepted = { sections: [{ name: 'x', text: 'y' }] }
  assert.equal(await assemble(accepted, agent()), accepted)
  assert.equal(await assemble(accepted, agent()), accepted)
  assert.equal(logs.warn.length, 1)
  assert.match(logs.warn[0], /native deferral is inactive/)
})

const SDK = [
  'interface ToolArgsMap {',
  '  /** Read a file. */',
  '  read: { path: string }',
  '  mcp__docs__read: {',
  '    id: string',
  '  }',
  '  tool_search: { query?: string }',
  '}',
  'interface ToolOutputMap {',
  '  read: string',
  '  mcp__docs__read: string',
  '  tool_search: string',
  '}',
].join('\n')

test('PTC mode rewrites the generated SDK section and appends the catalog', async () => {
  const { agent, assemble, search } = setup()
  const caller = agent()
  const first = await assemble({ sections: [{ name: 'tools:sdk', text: SDK }], tools: [] }, caller)
  const sdk = first.sections.find(section => section.name === 'tools:sdk').text
  assert.ok(!sdk.includes('mcp__docs__read'))
  assert.ok(sdk.includes('read: { path: string }'))
  assert.ok(sdk.includes('tool_search'))
  assert.match(first.sections.find(section => section.name === 'tool-search:catalog').text, /Inside run_code/)
  await search({ names: ['mcp__docs__read'] }, caller)
  const second = await assemble({ sections: [{ name: 'tools:sdk', text: SDK }], tools: [] }, caller)
  assert.ok(second.sections.find(section => section.name === 'tools:sdk').text.includes('mcp__docs__read'))
})

test('an SDK section with an unknown layout is left unfiltered and warned about once', async () => {
  const { agent, assemble, logs } = setup()
  const accepted = { sections: [{ name: 'tools:sdk', text: 'declare const tools: unknown' }], tools: [] }
  assert.equal(await assemble(accepted, agent()), accepted)
  assert.equal(await assemble(accepted, agent()), accepted)
  assert.equal(logs.warn.length, 1)
})

test('rejects an empty or malformed configuration at load', () => {
  const ctx = { on() {}, effect() {}, logger: { info() {}, warn() {} }, tools: { register() {}, schemas: () => [] } }
  assert.throws(() => plugin.apply(ctx, { defer: [] }), /`defer` must list at least one/)
  assert.throws(() => plugin.apply(ctx, { defer: ['a'], keep: [''] }), /non-empty strings/)
  assert.throws(() => plugin.apply(ctx, { defer: ['a'], maxResults: 0 }), /positive integer/)
})

test('helpers: glob, ordering, terms, ranking, grouping, summary', () => {
  assert.equal(plugin.compileGlob('mcp__a.b__*')('mcp__a.b__tool'), true)
  assert.equal(plugin.compileGlob('mcp__a.b__*')('mcp__aXb__tool'), false)
  assert.deepEqual(['b', 'B', 'a'].sort(plugin.compareNames), ['B', 'a', 'b'])
  assert.deepEqual(plugin.queryTerms('Send, MAIL; send-mail'), ['send', 'mail'])
  const ranked = plugin.rankTools(
    [{ name: 'b', description: 'mail' }, { name: 'a', description: 'mail' }, { name: 'mail', description: 'x' }, { name: 'z', description: 'x' }],
    ['mail'],
  )
  assert.deepEqual(ranked.map(entry => entry.tool.name), ['mail', 'a', 'b'])
  assert.equal(plugin.catalogGroup('mcp__docs__read'), 'mcp__docs')
  assert.equal(plugin.catalogGroup('read'), 'read')
  assert.equal(plugin.summarize('one\ntwo', 10), 'one')
  assert.equal(plugin.summarize('abcdefghij', 5), 'abcd…')
})
