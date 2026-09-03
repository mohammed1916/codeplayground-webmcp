# Code Playground WebMCP

A standalone WebMCP-enabled algorithm visualization playground. The app opens directly to the live code workspace and can dynamically visualize arrays, heaps, queues, stacks, linked lists, maps, sets, grids, DP tables, graphs, and trees from JavaScript `viz.*` calls or traced Python variables.

## WebMCP tools

The home page registers six browser-native WebMCP tools:

| Tool | Purpose |
| --- | --- |
| `visualizer_get_workspace` | Inspect run state, variables, visual mappings, and bounded source/input chunks. |
| `visualizer_run` | Run the currently accepted source and inputs. |
| `visualizer_get_frame` | Read the current rendered frame as compact structured data. |
| `visualizer_control_playback` | Play, pause, seek, step, or change playback speed. |
| `visualizer_configure_visuals` | Dynamically bind traced variables to sequence, grid, heap/tree/graph, scalar, or associative renderers. |
| `visualizer_propose_python` | Stage complete Python source/input edits as a review diff. Nothing changes until a person accepts. |

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:5173/`. In a WebMCP-capable browser or ChatGPT in-app browser, the header should show `Agent-ready`.

## Verification

```bash
npm test
npm run build
```
