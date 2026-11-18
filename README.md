# Volis

An Obsidian plugin that turns a canvas into a working surface for cards, notes and ideas — with AI built in.

Volis starts where Obsidian Canvas stops. Canvas nodes hold a link, but they do not know what they point to. Volis identifies block-reference cards, gives every node a type and colour, connects them with labelled edges, and lets an AI read the whole board and write its answer back into it.

Everything stays local except the requests you explicitly send to your own AI provider.

## Features

**Cards that stay cards**
- Recognise `![[file#^block-id]]` nodes, show their date badge, and edit them in place without leaving the board.
- Editing writes back to the source note; external note changes refresh the node automatically.
- Insert real notes, cards, media, sticky notes and text from a filtered search panel, or by dragging files in.

**Board manipulation**
- Multi-select, drag, resize, align and distribute. Smart guides appear while dragging.
- Group nodes into labelled frames with their own background colour; moving a frame moves its members.
- Connection tool with colour, three arrow states and edge labels — add or edit a label from the line's toolbar or by double-clicking the line itself.
- Connections can carry a semantic relation (supports, refutes, causes, derives, source, sequence). The relation lives on the edge, shows on the line, and is sent to the AI as context.
- Per-node colours with a custom colour picker.
- Type badges for card / note / text / media nodes.
- In-board search that zooms to and highlights the matching node.
- Read-only board health check that reports broken references, dangling lines, unlabelled connections and duplicates — fixes are manual and undoable.
- Minimap for navigating large boards.
- Read-only help panel listing the shortcuts that work inside the board.
- Floating outline generated from the connections: derives and causes build the hierarchy, sequence orders siblings, and supports / refutes / source show up as badges.
- Markdown export with a preview: copy it or save it as a note next to the board, as headings or as a nested list.

**AI on the board**
- Select nodes (or a whole group) and ask questions about them in a chat-style panel.
- Multiple model profiles: OpenAI-compatible and Anthropic protocols, switchable at any time. Each profile carries its own context window, output cap and thinking mode.
- Only the board snapshot and your question are sent — no telemetry, no background calls.
- Answers can be inserted as new nodes, written over the source node, or saved as a note.
- Conversation history per board, with the exact input snapshot of each turn kept in a collapsible block.
- Automatic handling of output caps: continuation, token-budget accounting and cache-aware prompts.

**Safety**
- The board file stays JSON Canvas-compatible; Volis-specific edge metadata (labels, relations) lives only in the board file. Uninstalling leaves your notes untouched.
- No block format changes and no new card files.
- API keys are stored only in the local plugin settings.

## Installation

Copy `main.js`, `manifest.json` and `styles.css` into:

```
<vault>/.obsidian/plugins/volis/
```

Then enable **Volis** under Settings → Community plugins. A full reload (`Ctrl/Cmd + R`) is recommended after updating.

Requires Obsidian 1.13.0 or newer. Desktop only.

## AI setup

1. Settings → Volis → AI → **Add profile**.
2. Pick a service preset or enter an OpenAI-compatible / Anthropic Messages endpoint, model name and API key.
3. The context window and output cap are inferred from the model name. Use **Probe** to read the real values where the provider allows it, or set them manually.
4. Select nodes on the board and press the Volis ribbon icon (or run **Volis: Open AI panel**).

For large boards, a model with a 200K+ context window is recommended. The AI panel shows the exact token accounting for every turn.

## Development

```
npm install
npm run build     # type-check + production bundle
npm run dev       # watch mode
```

The build writes `main.js` at the repository root. Source lives in `src/`:

```
src/
  main.ts              entry point, ribbon icon, commands, events
  settings.ts          settings model and migration
  settingsTab.ts       settings UI
  types.ts             shared types
  parse/               block-reference parsing and location
  store/               card reads and writes
  canvas/              node index, badges, sync, actions, context menu
  board/               board view, storage, insert search, card writer
  ai/                  provider protocols, capability presets, token budgeting
  ui/                  modals and inline editors
```

## Design constraints

1. A card never becomes a file.
2. Canvas files remain standard JSON Canvas and survive uninstall.
3. A node's identity comes only from its link — nothing extra is stored.
4. Code touching Canvas internals is guarded so a failure degrades instead of crashing.
5. No network calls without an explicit user action.

## License

MIT. See [LICENSE](LICENSE).

Releases up to and including 0.4.0 were published under GPL-3.0. Starting with
the next release, the plugin is licensed under MIT.

## Network use and privacy

- Volis makes no background requests and collects no telemetry.
- AI requests are sent only when you explicitly send a message, directly to the
  provider you configured (OpenAI-compatible or Anthropic).
- API keys and model settings are stored only in this plugin's local settings.
- Board and note content is sent only as part of a request you initiate.
