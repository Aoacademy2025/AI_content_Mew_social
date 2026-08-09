# Video projects pin Brand Profile revisions

Date: 2026-08-09
Status: Accepted

A Brand Look Revision creates an immutable Brand Profile Revision. New video projects start on the latest revision, while existing projects keep the revision they already use so re-rendering cannot silently change their visual identity; adopting a newer revision is always an explicit creator action. This favors reproducible client work over automatic propagation of the newest brand settings.

The same snapshot rule applies when a Project Look or Brand Profile Revision originates from a Trend Pack: the resolved visual recipe and pack version are stored with the project/revision instead of retaining a live dependency on the catalog entry. Updating, expiring or unpublishing a Trend Pack therefore affects only future selection; it cannot alter or block an existing project.
