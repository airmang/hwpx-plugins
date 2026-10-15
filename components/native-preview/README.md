# Integrated desktop HWPX file preview

This component is an internal part of the default Codex `hwpx-plugin`. A user
installs that plugin once; its second MCP server prepares the pinned OS helper
automatically. There is no separate consumer preview plugin or Node/Python setup.
The existing plugin prerequisite `uv` manages the bootstrap interpreter. Browser
and mobile code-execution bundles do not acquire desktop file access.

Both Codex MCP commands enter through `uv`. Windows does not require Bash:
the editing server uses an automatically prepared, verified Python environment,
while preview uses the pinned helper's private Node and frozen renderer. Python
launcher source is cached by its content hash, and embedded JSON stays inside
the Python process to preserve Windows quoting. POSIX editing retains the existing
managed shell launcher after the uv bootstrap.

Ownership is split deliberately:

- `python-hwpx`: experimental cache-independent document scene with injected glyph metrics.
- `python-hwpx-automation[native-preview]`: native rasterizer and bounded watch/worker service.
- This component: MCP Apps UI, host-authorized file handling, platform bundle assembly.

The UI uses PNG data URLs under the default MCP Apps CSP. Host resource metadata
is the only file authorization input. Page bytes and loopback credentials are not
model-visible. Independent view leases share a renderer for the same document;
closing one view cannot terminate another view's worker.

## Build from the coordinated development branches

The core scene and automation runtime changes must be installed together until
their package versions are released. Use Python 3.12, Node 24 and pnpm.

```sh
python -m pip install -e ../../../python-hwpx
python -m pip install -e '../../../python-hwpx-automation[native-preview]'
python -m pip install PyInstaller==6.22.3 pyinstaller-hooks-contrib==2026.8
python build-runtime.py --output ./build-local --font-directory /absolute/licensed-fonts --font-license /absolute/font-notice.txt
pnpm install --frozen-lockfile
pnpm build
pnpm test
python ../../scripts/package_desktop_plugin.py --runtime ./build-local/dist/HwpxPreview --node /absolute/node --output /absolute/NEW-MARKETPLACE --version 2.5.0-dev.1
```

`build-local` must be new. Build on the target OS and CPU architecture; a Windows
executable cannot be reused as a Mac runtime. The builder copies only explicitly
supplied font resources and their original notice; font files, runtime binaries,
and build output are not committed to this repository. Supplied font terms still
govern redistribution of any resulting bundle.

The generated local marketplace contains exactly one `hwpx-plugin` entry.
Register it with the host's supported CLI. Confirm
the live v7 UI resource and component version 0.1.9, then verify a real `.hwpx` click in the intended desktop
app. A controlled browser bridge test is not evidence of native file selection.

Version 0.1.9 uses a distinct installation cache and primary v7 UI resource so
product builds can be distinguished from the Windows/Mac 0.1.8 prototype.
The v2–v6 resource aliases remain available for existing viewers.

This source component derives from the Windows/Mac 0.1.8 prototype. Product-package
relocation needs separate platform validation before publication. The integration source does not change published release coordinates.
`qualityValidated` remains false for arbitrary documents. Linux, Intel Mac and
public signed/notarized distribution are not claimed.

## Integration validation and remaining release work

The original Windows 0.1.8 bundle was confirmed by a user after a native desktop
file click, with the table visible. The original Mac 0.1.8 bundle has the same
kind of native table confirmation. Those observations concern the prototype.

For this product-package relocation, Windows checks cover packaged MCP stdio,
URI-style drive paths, Unicode/spaced paths, independent viewer leases, file
updates, and PNG delivery. The synthetic table and a retained 30-page private
regression document reproduce the previous Windows PNG bytes. Private documents,
workstation logs and font files are excluded from this source component.

Before a coordinated public release:

1. Merge/release the core scene API, then set the automation extra's floor to
   that released version; do not assume every existing 6.8.0 wheel has the scene.
2. Release the automation runtime, then build this component on each target OS
   from the released wheel pair and record their exact versions and hashes.
3. Verify the integrated single-plugin package on both target platforms: native
   file click/table display, save refresh, cancellation and process cleanup.
4. Resolve font redistribution terms and platform signing/notarization before
   distributing platform binaries. This PR contains source only.

Release coordination, including the unreleased core dependency floor, is recorded
in [RELEASE.md](RELEASE.md).

## Helper delivery and cache

`scripts/package_desktop_plugin.py` assembles the normal plugin plus a private
local-test archive. `prepare-local.mjs` is an internal assembly/smoke utility; its
legacy standalone marketplace is not the consumer installation path.

For a public build, publish target-native helper archives as product GitHub
release assets and pin their archive SHA256 and `FILES.json` SHA256 in
`packaging/native-preview-artifacts.json`. The bootstrap verifies every installed
file before execution. It stages into a private directory and atomically commits
a content-addressed cache generation; concurrent starts do not replace or delete
another running version. Verified cache reuse requires no helper download.

Cold starts may download the helper and a uv-managed Python interpreter. The
preview server has its own 180-second startup budget. Unsupported targets or an
unreleased matrix produce an explicit error; existing editing tools remain on
their independent MCP server. No system Node or Python is required by users.

Run `python scripts/validate_hwpx_plugin.py --release` before publishing. Empty
platform coordinates and local file URLs cannot pass that gate. Source-only
protocol CI does not constitute a Windows/Mac binary build or native click test.

Windows uses extended filesystem paths when preparing the helper and importing
editing modules. The Node entrypoint receives a normal drive/UNC path because
its main-module resolver does not accept the extended Win32 namespace. Automation
also normalizes the frozen font-resource path; use the coordinated development
automation branch when rebuilding. Hidden editing children explicitly inherit
MCP stdin/stdout/stderr. Do not change system long-path policy to work around a
package relocation failure.
