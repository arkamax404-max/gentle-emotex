# USB serial output for the LED panel
Sends avatar frames, ownership and clock metadata to the LED display over USB CDC, as a new output alongside the HTTP/LED and D200 paths.
Branch: feat/usb-serial-output. Baseline: cc0f599. No push or release is authorized by this document; the firmware side lives in its own repository and its session.

## Specs
S1. "Se trata de poder comunicarnos con el displayLed via usb (puerto serie), seria un comando tipo /emote usbOn/usbOff" — a new output with an On/Off command, obeying the same rules as the existing outputs.
S2. The wire protocol is the firmware's documented contract, `docs/serial-transport.md` "wire protocol v1", not something invented here: `EMOTE\n` → `EMOTE_READY\n`, `EMTS` frames (little-endian, header at offset 0-17, CRC-32 reflected 0xEDB88320 over magic..payload, echoed `requestId`), 12-byte `EMTR` replies matched by id and scanned byte-wise (console lines interleave), `EMTE\n` → `EMOTE_EXIT\n`, one frame in flight (stop-and-wait), at-least-once resend on a missing or NACK reply, and no automatic control retries.
S3. Owner decision: "serialport opcional, carga diferida" — `serialport` goes in optionalDependencies and is imported only when the user runs `usbOn`. A missing module reports a clear warning and leaves every other output, the avatar and delivery untouched.
S4. Owner decision: "Autodetectar, con puerto opcional" — bare `usbOn` selects the single USB CDC port visible; `usbOn <port>` fixes that port for this session only, writes nothing, and returns to auto-detection at the next start. Nothing is persisted, matching the D200 port rule.
S6. Owner constraint: "llegado el caso nunca vamos a usar mas de un display conectado por usb, para que lo tengas en cuenta" — one USB display at most: a single transport instance, no per-port registry, and auto-detection succeeds only with exactly one candidate; ambiguity is refused with an explicit request for the port rather than a guess.
S5. The serial path carries the same metadata as HTTP: session identity, project name on images only, and the idle-clock state, with the same validation. Wire logs and diagnostics never expose identity bytes.

## Tasks
T1 | S1 | parent inline | in progress | Feature branch and this authority document | commit
T2 | S2 | parent inline, test-first | pending | Pure protocol module: frame builder for the four operations, CRC-32 via `zlib.crc32`, reply parser that scans for `EMTR`, and the exact length/flag validation the firmware applies | commit
T3 | S2-S5 | parent inline, test-first | pending | Transport: optional lazy `serialport` load, port auto-detection, handshake `EMOTE`/`EMOTE_READY`, stop-and-wait queue with one in flight, resend and bounded timeouts, heartbeats, claim/release, clean exit | commit
T4 | S1-S5 | parent inline | pending | Extension wiring: a `usb` output with `/emote usbOn [port]` and `/emote usbOff`, frame sink, lifecycle and panel row | commit
T5 | S1-S5 | parent inline | pending | Docs (README command table and section, AGENTS.md, CHANGELOG) and the full suite | commit
T6 | S1-S5 | parent inline + native review | pending | Review, merge and publication decisions | commit

## Log
L1. Original request, verbatim: "ahora vamos a hacer nuestra parte para lo que tengo trabajando en la sesion del firmware. Se trata de poder comunicarnos con el displayLed via usb (puerto serie), seria un comando tipo /emote usbOn/usbOff".
L2. Read-only exploration of `D:\Desarrollo\emote-display-firmware`: the transport already exists and is documented (`docs/serial-transport.md`, `include/serial_protocol.h`, `include/serial_ingress.h`, `odd/tasks/usb-serial-ingress.md`). The firmware side is therefore a contract to satisfy, not a design to co-write here.
L3. Environment check: Node v24 with `zlib.crc32` available, and no serial library installed in this package. `node:fs` on `\.\COMx` cannot set a baud rate, so it cannot satisfy the firmware's 115200 8N1 requirement; that option was presented and rejected.
L4. Owner decisions, verbatim answers: "serialport opcional, carga diferida (recomendado)" and "Autodetectar, con puerto opcional (recomendado)". Recorded as S3 and S4.
L5. Owner constraint, verbatim: "llegado el caso nunca vamos a usar mas de un display conectado por usb, para que lo tengas en cuenta". Recorded as S6: at most one USB display ever, so the transport is a single instance with no per-port registry, and auto-detection must find exactly one candidate — if more than one port looks like a CDC device it refuses and asks for an explicit port instead of guessing.
