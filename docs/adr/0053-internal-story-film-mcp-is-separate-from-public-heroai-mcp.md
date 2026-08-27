---
status: accepted
---

# Internal Story Film MCP is separate from Public HeroAI MCP

During the Mew-only pilot, Hero Story Film uses a dedicated Internal Story Film MCP transport rather than registering its tools on the existing Public HeroAI MCP. Both Studio and the internal transport call the same Story Film Control Plane and share Hero authentication and audit foundations, but public members cannot authenticate to the internal transport or discover its `start`, `read` and `decide` tools. This prevents an unfinished internal workflow and Grok-subscription lane from changing public tool selection or implying customer access; a later public launch can expose a separate adapter to the same control plane after API or RunPod generation and Credits settlement are ready.
