# Claude bundle inspection policy

The vendoring gate keeps individual files at or below 256 KiB and the whole
plugin at or below 512 files. These are conservative directory-inspection
bounds already enforced by this repository, not demonstrated Python import or
execution limits. Do not solve a refresh failure by raising them without
reviewing the exact target host and its scanning semantics.

The official organization-plugin guide documents a separate ZIP upload limit
(under 200 MB): https://support.claude.com/en/articles/13837433-manage-plugins-for-your-organization
That limit does not establish per-file inspection coverage or runtime behavior.
Verification date: 2026-11-01. Host scanning and live installation were not
independently tested in this change.

Keep upstream wheels unchanged when vendoring. Split oversized readable source
or data in the canonical core project, test it, and release it there first.
Never compress/encode executable source to evade inspection. The vendor now
checks the complete candidate, including VENDOR.json, before replacing the old
engine. A rejected size/path/count check leaves the old engine intact.

Local candidate-wheel experiments must record their source SHA and use an
explicit non-public version. They must not be committed as published PyPI
artifacts or silently replace the production lock.

On a lock or vendor failure, the refresh command restores the caller’s original
pyproject, lock, and plugin-manifest bytes (rather than checking out Git HEAD).
This is not a filesystem transaction: process termination or an I/O failure
during engine replacement is not guaranteed to roll back the engine tree.
