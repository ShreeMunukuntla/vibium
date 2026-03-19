# Spec: Media Channel — Dedicated BiDi Connection for Screenshot Capture

## Context

Recording with screenshots is slow. Benchmarking saucedemo E2E:

| | With recording | Without recording | Overhead |
|--|---------------|-------------------|----------|
| **Playwright** | 17.3s | 16.3s | +1s |
| **Vibium** | 27.9s | 12.4s | +15.5s |

Without recording, Vibium (12.4s) is faster than Playwright (16.3s). The entire slowdown is screenshot capture blocking the action pipeline.

### Why it's slow

The current `dispatch()` flow in `router.go`:

1. `RecordAction()` — before marker (fast)
2. `handler()` — actual browser action
3. `endTime := time.Now()` — capture real end time
4. `captureActionSnapshot()` — DOM snapshot if enabled
5. `CaptureRecordingScreenshot()` — **blocking screenshot on main BiDi channel** (50–200ms)
6. `RecordActionEnd()` — after marker
7. Release `dispatchMu`

The BiDi WebSocket is shared. A fat base64 screenshot response sitting in the pipe delays the next action's BiDi commands. Chrome processing the capture and pushing megabytes of image data back through the same connection is the real bottleneck.

## Design: Second BiDi WebSocket

Open a **second BiDi WebSocket connection** to the same browser endpoint. BiDi is just a WebSocket — Chrome handles concurrent connections fine (same as having multiple DevTools tabs open).

The media channel handles screenshot capture asynchronously while the main channel stays clear for automation commands. After an action completes, `dispatch()` tags a timestamp and fires a non-blocking capture on the media channel. The next action starts immediately.

Future extensions: read-only "TV monitor" for screen sharing, and two-way "VNC mode" for remote mouse/keyboard input.

## New file: `clicker/internal/api/media.go`

### MediaChannel struct

```go
type MediaChannel struct {
    conn       *bidi.Connection
    mu         sync.Mutex
    closed     bool
    nextID     int
    pending    map[int]chan json.RawMessage
    pendingMu  sync.Mutex
    stopChan   chan struct{}
    inflightWg sync.WaitGroup
}
```

| Field | Type | Purpose |
|-------|------|---------|
| `conn` | `*bidi.Connection` | Second WebSocket to the same browser |
| `nextID` | `int` | Command ID counter (starts at 2,000,000 to avoid collision) |
| `pending` | `map[int]chan json.RawMessage` | Response routing by command ID |
| `inflightWg` | `sync.WaitGroup` | Tracks in-flight async screenshots so `Drain()` can wait |
| `stopChan` | `chan struct{}` | Signals the read loop to exit |

### Command ID ranges

| Source | ID range | Notes |
|--------|----------|-------|
| Client (passthrough) | 1 – 999,999 | Client-assigned IDs forwarded to browser |
| Main channel internal | 1,000,000 – 1,999,999 | `sendInternalCommand` in router.go |
| Media channel | 2,000,000+ | Media channel commands |

### Key methods

- `OpenMediaChannel(wsURL string) (*MediaChannel, error)` — create connection, start read loop
- `SendCommand(method string, params map[string]interface{}) (json.RawMessage, error)` — 5s timeout
- `SendCommandWithTimeout(method, params, timeout)` — configurable timeout
- `CaptureScreenshotAsync(recorder, context, opts, actionEnd)` — fire goroutine, increment `inflightWg`, capture on media channel, decode, call `recorder.AddScreenshot()`
- `CaptureSnapshotAsync(recorder, callId, snapshotType, context, frameURL, opts)` — same pattern for DOM frame-snapshots
- `Drain()` — `inflightWg.Wait()`, blocks until all in-flight screenshots complete
- `Close()` — close `stopChan`, then close the WebSocket connection

## Lifecycle

1. **Creation**: Lazy — opened on `recording.start` with `screenshots: true`. No second connection for sessions that never record.
2. **WebSocket URL**: Stored on `BrowserSession` as `wsURL` field, set during `OnClientConnect` from `launchResult.WebSocketURL` (local) or `r.connectURL` (remote).
3. **Read loop**: Routes BiDi responses by command ID. Discards events (main channel handles those).
4. **Drain**: `mc.Drain()` blocks until all in-flight screenshots complete. Called by `handleRecordingStop` before building the zip.
5. **Close**: Closes `stopChan`, then closes the WebSocket.
6. **Session teardown**: Media channel closed in `closeSession()`.

## Changes to `dispatch()`

| Aspect | Before | After |
|--------|--------|-------|
| Screenshot channel | Main BiDi connection | Dedicated media channel |
| Blocking | `CaptureRecordingScreenshot` blocks dispatch | `CaptureScreenshotAsync` returns immediately |
| `screenshotInFlight` | Atomic to prevent overlapping captures | Removed (media channel handles concurrency) |
| `dispatchMu` hold time | Includes screenshot wait | Releases after handler + fire-and-forget |
| `afterSnapshot` in RecordActionEnd | Synchronous snapshot name | Empty string (snapshot added async) |

### Before-snapshots

Keep before-snapshots on the main channel synchronously for the initial implementation. They only apply to interaction handlers (click, fill) and the ~2s timeout is already short.

## Recording start/stop integration

- `handleRecordingStart`: if `opts.Screenshots || opts.Snapshots` and `wsURL != ""`, call `OpenMediaChannel(wsURL)`, store on session
- `handleRecordingStop`: `mc.Drain()` (wait for in-flight screenshots), `recorder.Stop()` (build zip), `mc.Close()`
- `closeSession`: close media channel if session torn down mid-recording

## Agent/MCP path integration

- `Handlers` struct gets `mediaChannel *MediaChannel` field
- `browserRecordStart`: open media channel
- `Call()`: use `h.mediaChannel.CaptureScreenshotAsync()` if available, else fall back to sync `CaptureRecordingScreenshot`
- `getWSURL()` helper: derives URL from `connectURL` or `launchResult`

## Graceful fallback

If media channel fails to open (nil check), fall back to current synchronous behavior. Log a warning, no error to the client. `screenshotInFlight` stays on `BrowserSession` for the fallback path.

## Wire format examples

Main channel (action dispatch):
```json
{"id":1000042,"method":"input.performActions","params":{}}
```

Media channel (async screenshot, fires in parallel):
```json
{"id":2000001,"method":"browsingContext.captureScreenshot","params":{"context":"ABC123","format":{"type":"image/jpeg","quality":0.5}}}
```

Media channel response:
```json
{"id":2000001,"type":"success","result":{"data":"<base64 JPEG>"}}
```

## Memory considerations

At 100ms capture interval with 50KB JPEG frames over a 30s recording: 300 frames × 50KB = ~15MB. Acceptable. Quality and interval are tunable via recording options.

## Files to modify

| File | Changes |
|------|---------|
| `clicker/internal/api/media.go` | **New file.** MediaChannel struct, OpenMediaChannel, readLoop, SendCommand, CaptureScreenshotAsync, CaptureSnapshotAsync, Drain, Close |
| `clicker/internal/api/router.go` | Add `mediaChannel` and `wsURL` to BrowserSession. Set `wsURL` in OnClientConnect. Close in closeSession. Modify dispatch() for async screenshots |
| `clicker/internal/api/handlers_recording.go` | Open media channel in handleRecordingStart. Drain + close in handleRecordingStop and handleRecordingStopChunk |
| `clicker/internal/agent/handlers.go` | Add `mediaChannel` to Handlers. Open in browserRecordStart, drain+close in browserRecordStop. Async screenshots in Call(). Add getWSURL() helper |

## Verification

1. `make test` — all existing tests pass
2. **Performance**: re-run saucedemo benchmark, expect Vibium recording time to drop from ~28s to ~14–15s
3. **Correctness**: inspect zip — `trace.trace` has `screencast-frame` events, `resources/` has screenshots, frame-snapshot events have correct linkage
4. **Filmstrip density**: more frames than before (continuous vs per-action)
5. **Drain**: rapid actions + immediate stop — all pending frames present in zip
6. **Fallback**: force media channel failure, verify sync fallback works
7. **Leak**: close session mid-recording, verify goroutines cleaned up

## Future extensions

1. **TV Monitor**: extend `CaptureScreenshotAsync` to run a continuous capture loop, emitting frames to external viewers over HTTP/WebSocket. `StartScreencast(context, opts, frameCh chan<- []byte)`
2. **VNC Mode**: accept mouse/keyboard input from external sources, relay as `input.performActions` on the media channel. Automation commands and VNC input never contend for the same WebSocket. `RelayInput(method, params) error`
3. **Multi-tab**: capture from multiple contexts, track active tab
