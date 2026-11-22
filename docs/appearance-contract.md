# Shared desktop appearance contract — version 1

**Agreed T3 contract (S4–S5), superseding the draft.** Gentle-emote owns the schema
and global persistence policy; desktop applies confirmed preferences and its controls
write narrow patches to the same source. There is no independent persistent desktop
appearance state. Rust integration is implemented in the desktop repository, separately
from the TypeScript store in `src/appearance.ts`.

## Quick path

1. Resolve the agent directory and read a validated snapshot without creating anything.
2. Submit desktop leaf changes with the last confirmed revision, off the render thread.
3. Confirm only a committed snapshot; on conflict reload and explicitly choose a fresh patch.

No service, CLI, daemon, dependency or panel control is added by the TypeScript store.
The standalone desktop app uses Rust filesystem APIs; Node and shell startup files are
not prerequisites. Its explicit override is `--agent-dir ABSOLUTE`.

## Location and defaults

Resolve the directory in this order, without consulting cwd or project configuration:

1. Explicit absolute, nonempty application override, when supplied.
2. `PI_CODING_AGENT_DIR`, when defined: it must be absolute and nonempty.
3. Absolute, nonempty `HOME`, followed by `.pi/agent`.

Invalid selected input fails instead of falling back. Symlinked paths are rejected;
choose the real directory explicitly. TypeScript also rejects `.`/`..` path components
rather than normalizing away a symlink check. Diagnostics should identify the resolved
path and error category, not file contents.

The sole source is `<agentDir>/extensions/gentle-emote/appearance.json`. Absence means
this virtual revision-zero snapshot; reads never create directories or files:

```json
{
  "version": 1,
  "revision": 0,
  "desktop": {
    "backgroundRgb": [0, 0, 0],
    "backgroundOpacity": 55,
    "transparentBackground": true
  }
}
```

Opacity 55 means 45% transparency. First successful save creates revision 1. Missing
fields in an existing document are errors, not invitations to insert defaults.

## Schema and patch authority

| Field | Required version-1 rule |
| --- | --- |
| `version` | Exactly integer 1; future versions fail closed. |
| `revision` | Integer 0–9007199254740991; increment even for an accepted no-op; never wrap. |
| `desktop` | Object containing all three required leaves below. |
| `desktop.backgroundRgb` | Exactly three integers, each 0–255; window underlay RGB. |
| `desktop.backgroundOpacity` | Integer 0–100, percent opacity; transparency is 100 minus opacity. |
| `desktop.transparentBackground` | Boolean; false requires opacity 100; true with 100 is valid. |
| `image` | Reserved, not applied or patchable; no PNG source migration. |

A nonempty patch may contain only the three desktop leaves, with a separate
`expectedRevision`. No group replacement, deletion, arbitrary merge, caller-supplied
version or revision is allowed. Turning transparency off requires one grouped patch
with `transparentBackground: false` and an explicitly supplied `backgroundOpacity: 100`,
even when the current opacity is already 100; reject an ungrouped false patch before
acquiring a lock. Never normalize silently. Validate the entire resulting document before committing.

Every JSON number, including unknown nested fields and reserved `image` values, must
be a lexical decimal integer in ±9007199254740991: no fractional notation or exponents,
even `1.0` or `1e0`. Reject duplicate keys at every depth, including escaped equivalents,
before parsing loses information. Preserve unknown members semantically on writes;
whitespace and key ordering need not survive. Fractional image coverage is invalid in
this file until a future protocol explicitly changes the numeric policy.

PNG composition remains in existing user-global `config.json`: it is distinct from
window underlay/opacity. Physical HTTP LED and USB images remain opaque. Dedicated
D200 appearance belongs to its Ulanzi Studio plugin; internal terminal rendering is
unchanged. Desktop-drawn clock appearance is not added to this schema.

## Bounded reads and confirmed UI

Read through one opened regular-file descriptor, at most 65537 bytes, rejecting more
than 65536 bytes. Require valid UTF-8 without a leading UTF-8 BOM and a JSON object
root, supported version and the complete schema. Every decoded string key and value,
including unknown nested fields, must contain only Unicode scalar values: reject lone
high/low surrogate escapes; accept valid surrogate pairs and literal non-BMP characters. Apply the same 65536-byte UTF-8 cap to serialized output, including
unknown fields. Invalid input preserves source bytes and disables writes; no repair,
truncation, automatic migration/import or deletion of legacy settings is permitted.

`MAX_CONTAINER_DEPTH` is **64**, counting the root object as depth **1**. Every nested
object or array adds one; scalar values add no container depth. This includes unknown
and reserved fields. Total depth 64 is valid; opening a container at depth 65 is
`invalid`, rejected by the lexical pass before recursive document parsing or serialization.
For example, a root `unknown` value containing 63 arrays around scalar `0` reaches
exactly depth 64; 64 such arrays reach depth 65 and must be rejected. Rejected writes
preserve source bytes and revision and leave no owned lock remnants.

The TypeScript API returns typed status/snapshot results: `readAppearance(options)`
returns `missing` with virtual defaults or `ready` with confirmed data. Errors return
no snapshot. `patchDesktopAppearance(options, expectedRevision, patch)` returns `saved`,
`conflict` with current truth, `revision-exhausted`, `busy`, `invalid`, `unsafe-path`,
`unsupported-platform`, `io-error`, or `committed-durability-uncertain`; cleanup failure
is a separate flag.
Importing the module has no global side effects. It owns neither UI nor polling.

Desktop retains its last confirmed snapshot on errors, or uses visibly unconfirmed
defaults on first-load failure. Render only immutable confirmed snapshots; pending
controls must not present unsaved values as confirmed. Reload at startup, before showing
controls, after conflicts and via a **500 ms off-render worker poll**. Always validate,
not just compare timestamps. Coalesce jobs: at most one read/write per application at
a time. Poll timing is best effort, not a responsiveness guarantee. Errors remain visible
and retryable; never retry a committed patch blindly.

## Cooperative lock and atomic transaction

The stable sibling lock is a **directory** `appearance.json.lock`, created exclusively
with `mkdir` mode 0700. It contains a regular file named `owner`, exclusively created
(`wx` / Rust `create_new`) mode 0600. Generate 16 OS-random bytes, encoded as 32 lowercase
hex characters. Owner bytes are exactly `v1:<token>\n` (36 bytes).

1. Verify paths; create missing directories componentwise only on explicit save. Attempt
   lock mkdir; only already-exists retries, every 50 ms up to 1000 ms monotonic elapsed,
   then `busy`. Reject unsafe existing locks. No PID, age, timeout or malformed-marker
   recovery, lock stealing, or opening existing owner files for writing.
2. Write, sync and close the owner marker. Confirm directory identity, opened owner
   identity and exact token before mutation. Directory device/inode identity is stable
   while held; no competing compliant writer can replace it.
3. Under lock, reread and fully validate the source (absence is revision zero). Compare
   expected revision: mismatch returns `conflict` without source mutation. Maximum-safe
   revision returns `revision-exhausted`, never wrap/reset.
4. Apply only allowed leaves, preserve unknowns, increment revision, validate and bound
   the entire serialized UTF-8 document.
5. Create sibling `appearance.json.<token>.tmp` exclusively mode 0600; write all bytes,
   sync and close. Recheck paths, target type, temporary identity and lock identity/token.
   Atomically rename over the target on the same filesystem: this is the commit point.
   No unlink-target, copy fallback or partial in-place update is allowed.
6. Sync the parent directory where supported. Unsupported directory sync is tolerated;
   other postcommit failures report `committed-durability-uncertain` with the committed
   snapshot. Reload; do not roll back or blindly retry. Crash durability is not guaranteed.
7. On exit remove only an unrenamed temporary whose created identity still matches.
   Remove the owner only when identity and token match, then remove only the matching
   empty lock directory. A partial failed owner write may be removed only by its creator
   after confirming created identities. Unexpected identities are left untouched and
   cleanup errors reported independently; committed writes stay committed. Always attempt
   guarded lock cleanup independently, even if checking or removing the temporary fails;
   cleanup failures must not replace the transaction's original status or snapshot.

A crash can leave the lock indefinitely. Successful creation followed by failure to
capture the created object's identity has the same conservative outcome: leave it in
place and report cleanup/recovery needs; never unlink without proven ownership.
This branch has not been fault-injected in both implementations. Applications never
delete abandoned locks or orphan temps. Operator recovery is explicit, only after both applications and all writers
have stopped. Readers need no lock because writers replace complete files.

## Filesystem trust boundary

Inspect every existing path component from the filesystem root using symlink metadata;
reject symlinks and non-directory ancestors, and non-regular source/owner/temp leaves.
System ancestors need not belong to the user, but the agent directory and its descendants
must belong to the current user and deny group/other writes. Create private directories
0700 and files 0600; never chmod existing paths. Compare opened-file device/inode with
path metadata. Recheck before rename/unlink. Do not create anything merely to read.

This POSIX implementation is for cooperating same-user applications in trusted directories,
**not hostile-local-writer protection**: metadata/open and metadata/unlink checks have TOCTOU
windows. The TypeScript store fails closed on `process.platform === "win32"` or when
`process.getuid` is unavailable: both public read and patch APIs return the distinct
`unsupported-platform` status without a snapshot, before resolving paths or accessing
the filesystem. The pure path resolver remains available. No fallback, legacy write,
or change to existing RGB/PNG/desktop runtime behavior is introduced.

**Windows shared-store support remains pending**, not completed or abandoned: ACL and
atomic-replacement enforcement require a platform supplement and implementation before
the gate can be lifted. POSIX mode checks alone do not establish Windows safety. Stronger
descriptor-relative sandboxing is out of scope.
Before commit, errors leave source bytes unchanged. Never reset to defaults on failure.
