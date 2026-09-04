# ADR 0060: Isolate the Hero Voice Clone canary

Status: accepted — 2026-09-04

Hero Voice Clone is an account-scoped, AI Studio-only canary, not a release of Stock Hero Voice. It uses a dedicated clone-only RunPod endpoint, the intersection of the existing internal-AI and OmniVoice allowlists, and no role-based bypass; public users retain the existing teaser but cannot synthesize, while Video Editor, Story Film, MCP and stock-voice routes remain unchanged. A reference is private application-owned data retained until its owner deletes it (and removed during account deletion), and clone failure is terminal without automatic retry or fallback to another endpoint, voice or provider. This separation preserves a narrow Mew-first quality test while the model and upstream commercial-rights questions remain unresolved.
