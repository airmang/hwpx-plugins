# Coordinated native-preview release

The current development scene API is not in the published core 6.8.0 wheel.
Development validation must install the core and automation branches together;
matching their existing version strings is insufficient. The builder checks for
the scene API before starting. Do not publish development wheels under an
already published version.

Proposed next additive release coordinates, subject to the release owner's
confirmation and any intervening publication:

| Layer | Candidate | Required relationship |
| --- | --- | --- |
| Core | python-hwpx 6.9.0 | Contains the experimental renderer-neutral scene API |
| Automation | python-hwpx-automation 7.4.0 | native-preview extra requires core >=6.9.0,<7 |
| Compatibility shell | hwpx-mcp-server 7.4.0 | Pins canonical automation[mcp]==7.4.0; retains its bounded compatibility role |
| Internal helper | native-preview 0.1.9 | Rebuild each native target from the exact published core/automation wheel pair; publish pinned release assets |
| Default skill/plugin | hwpx-plugin 2.5.0 | Includes editing tools and automatic native helper preparation; one consumer installation |

Apply the sequence:

1. Merge the scene API and assign a new core release version. Publish and observe
   the core wheel/tag and hashes, and verify the API through that installed wheel.
2. Set automation's native-preview extra floor to that actual core release,
   assign the new canonical and compatibility versions, and run package/import
   boundary tests with the published core. Publish canonical automation first;
   observe remote artifacts before publishing the compatibility shell.
3. Rebuild the internal helper separately on Windows and Apple Silicon Mac
   using those released wheels and an explicitly supplied, licensed font set.
   Record Python/Node versions, module provenance, source commits, package file
   hashes, executable permissions and the native cache/executable paths.
4. Test the integrated single-plugin installation: native file click and page display, save refresh,
   incomplete-save recovery, cancellation, RSS limits, independent leases and
   process/temp-directory cleanup. Browser bridge checks are separate evidence.
   Confirm the active UI resource/version and the actual target-file renderer
   process; a successful install or an older prototype confirmation is insufficient.
5. Publish the target helper archives as GitHub release assets. Record their
   observed archive hashes and pinned file-inventory hashes in
   `packaging/native-preview-artifacts.json`; set `releaseStatus` to `released`
   only after Mac arm64 and Windows x64 assets exist and pass checks. Local
   `file:` coordinates must never enter the public manifest.
6. Update the normal plugin pins/contracts/version, regenerate all host bundles,
   and run `python scripts/validate_hwpx_plugin.py --release`. Publish the normal
   `hwpx-plugin` with this integrated Codex server, then verify an isolated public
   marketplace install with exactly one plugin and both editing/preview servers.
   No separate preview marketplace entry or manual runtime installation is part
   of the consumer flow.

This is a source-integration release plan, not publication approval. Keep the
three integration PRs draft until remaining release work is accepted. Native
binary distribution additionally needs the font redistribution decision and
platform signing/notarization work. Intel Mac, Linux native binaries, clean-machine
coverage and arbitrary-document Hancom fidelity are not implied by arm64 testing.

Fonts, platform executables and private/user documents stay outside public source.
The public wheels may retain their existing tracked application templates.
