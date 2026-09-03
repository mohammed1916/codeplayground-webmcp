# Code Playground WebMCP

A standalone WebMCP-enabled algorithm visualization playground. The app opens directly to the live code workspace and can dynamically visualize arrays, heaps, queues, stacks, linked lists, maps, sets, grids, DP tables, graphs, and trees from JavaScript `viz.*` calls or traced Python variables.


### Demo

Demo: [www.youtube.com/watch?v=ZDfXHrO67Dc](https://www.youtube.com/watch?v=ZDfXHrO67Dc)

Extended Silent Walkthrough: [youtu.be/BrXhr0kSsKs](https://youtu.be/BrXhr0kSsKs) (for Fix with AI/Propose code)

## WebMCP tools

The home page registers six browser-native WebMCP tools:

| Tool                             | Purpose                                                                                                 |
| -------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `visualizer_get_workspace`     | Inspect run state, variables, visual mappings, and bounded source/input chunks.                         |
| `visualizer_run`               | Run the currently accepted source and inputs.                                                           |
| `visualizer_get_frame`         | Read the current rendered frame as compact structured data.                                             |
| `visualizer_control_playback`  | Play, pause, seek, step, or change playback speed.                                                      |
| `visualizer_configure_visuals` | Dynamically bind traced variables to sequence, grid, heap/tree/graph, scalar, or associative renderers. |
| `visualizer_propose_python`    | Stage complete Python source/input edits as a review diff. Nothing changes until a person accepts.      |

## Local development

```bash
npm install
npm run dev
```

Open `http://localhost:5173/`. In a WebMCP-capable browser or ChatGPT in-app browser, the header should show `Agent-ready`.

## Hosted AI providers

Local Ollama only works when the app runs on `localhost`; hosted browsers cannot reliably call `127.0.0.1:11434` because of browser CORS rules. On Vercel, use the included `/api/chat` proxy and set one or both environment variables:

```bash
OLLAMA_API_KEY=...
GEMINI_API_KEY=...
```

If your Ollama Cloud account uses a custom compatible base URL, also set `OLLAMA_BASE_URL`; the default is `https://ollama.com/api`.

You can also enter a key in the provider panel during a session, but Vercel environment variables are better for demos.

## License

Copyright (C) 2026 Mohammed Abdullah <2023176026@student.annauniv.edu>

Licensed under the GNU Affero General Public License v3.0 or later. See [LICENSE](./LICENSE).

## Verification

```bash
npm test
npm run build
```
