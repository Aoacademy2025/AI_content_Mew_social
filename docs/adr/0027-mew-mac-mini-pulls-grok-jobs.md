---
status: accepted
---

# Mew's Mac mini pulls Grok jobs and keeps OAuth local

Hero persists Internal Grok B-roll jobs and their assets, while a single worker on Mew's Mac mini makes outbound requests to claim leased work, runs the authenticated Grok CLI and returns the generated assets. Grok OAuth never enters the Hero production server and no inbound port is opened on the Mac; if the worker is unavailable, accepted jobs remain Waiting for Grok Worker without provider fallback. This trades always-on availability and horizontal throughput for a smaller credential boundary and direct use of Mew's subscription-backed workflow.
