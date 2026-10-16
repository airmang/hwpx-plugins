# Contributing

This repository generates four host bundles from one canonical source. Edit the
root skill, references, examples, packaging templates, or host manifest; do not
hand-edit generated files under `plugins/`.

With sibling `python-hwpx` and `python-hwpx-automation` checkouts available,
select both explicitly and run:

```bash
export PYTHON_HWPX_REPO=/absolute/path/to/python-hwpx
export HWPX_AUTOMATION_REPO=/absolute/path/to/python-hwpx-automation
python scripts/build_hwpx_plugins.py
python scripts/validate_hwpx_plugin.py
python scripts/validate_shipped_code.py
python scripts/check_public_hygiene.py
uvx --from 'ruff>=0.12' ruff check --select E9,F .
uv run --no-project \
  --with-editable "${PYTHON_HWPX_REPO}[preview]" \
  --with-editable "${HWPX_AUTOMATION_REPO}[mcp,oracle,test]" \
  --with pytest python -m pytest -q
git diff --exit-code
```

Contract changes must be regenerated and validated across all four hosts. Never
commit local virtual environments, private benchmark routing, real user documents,
credentials, workstation paths, generated evidence, or output documents. Keep
fixtures synthetic and repository-only unless they are explicitly part of the
installed product. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## Integrated desktop preview

The [native preview implementation](components/native-preview/README.md) belongs
to the default Codex and Claude `hwpx-plugin` bundles. Its internal renderer archive has no separate
consumer marketplace identity. Core/automation development dependencies and
target-native build tools are for maintainers only. Other host bundles retain
their existing tool/skill integration.

Before publishing the coordinated plugin, run
`python scripts/validate_hwpx_plugin.py --release`. It rejects unreleased, local
or incomplete platform asset coordinates. The ordinary validator permits the
explicitly unreleased source matrix for development. Never publish that matrix.
