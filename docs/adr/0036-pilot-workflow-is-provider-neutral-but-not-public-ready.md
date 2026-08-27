---
status: accepted
---

# The pilot workflow is backend-neutral but not public-ready

Hero stores narrative intent, approvals and asset requirements independently from Grok-specific commands, while each generation job pins an explicit Narrative Generation Backend. Phase 1 implements only Mew's subscription-backed Grok worker and deliberately excludes public access, customer Credits, multi-tenancy and API/RunPod execution. A later public product may reuse the proven story, review and job contracts while replacing the backend with a supported API or RunPod route and adding commercial controls; it may never route public work through Mew's Grok subscription. This preserves a clean migration seam without making the internal prototype carry premature billing and platform complexity.
