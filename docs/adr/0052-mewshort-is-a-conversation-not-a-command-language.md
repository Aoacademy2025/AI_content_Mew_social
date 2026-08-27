---
status: accepted
---

# Mewshort is a conversation, not a command language

Mew starts Hero Story Film with one natural-language `$mewshort` request that supplies or identifies the content package and Presentation Mode. The skill then keeps one Active Story Film in conversational context, returns Hero deep links when a visual gate is ready, accepts plain-language approval or scene changes, and asks for final render confirmation. Mew does not memorize project IDs, Stage names, revisions, retry commands or queue syntax. Internally, every approval is bound to the exact pending project, Stage and revision before MCP submits it. A new session can request “ต่อโปรเจกต์ล่าสุด”; Hero resolves the latest eligible project or asks Mew to choose when more than one is plausible.
