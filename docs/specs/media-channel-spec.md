# Spec: Media Channel — Async Screenshots, Live Streaming, and Remote Input

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

The media channel serves three purposes:

1. **Recording** — async screenshot capture, fire-and-forget from `dispatch()`, unblocking the action pipeline
2. **Streaming** — continuous capture loop, relay frames over a WebSocket server to external viewers
3. **Remote input** — accept mouse/keyboard/touch from stream viewers, relay as BiDi `input.performActions`

All three use **only BiDi commands** (`browsingContext.captureScreenshot`, `input.performActions`). No CDP.

## Part 1: Async Recording (Phase 1)

### New file: `clicker/internal/api/media.go`

#### MediaChannel struct

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

#### Command ID ranges

| Source | ID range | Notes |
|--------|----------|-------|
| Client (passthrough) | 1 – 999,999 | Client-assigned IDs forwarded to browser |
| Main channel internal | 1,000,000 – 1,999,999 | `sendInternalCommand` in router.go |
| Media channel | 2,000,000+ | Media channel commands |

#### Key methods

- `OpenMediaChannel(wsURL string) (*MediaChannel, error)` — create connection, start read loop
- `SendCommand(method string, params map[string]interface{}) (json.RawMessage, error)` — 5s timeout
- `SendCommandWithTimeout(method, params, timeout)` — configurable timeout
- `CaptureScreenshotAsync(recorder, context, opts, actionEnd)` — fire goroutine, increment `inflightWg`, capture on media channel, decode, call `recorder.AddScreenshot()`. When capture loop is running, picks nearest frame from ring buffer instead.
- `CaptureSnapshotAsync(recorder, callId, snapshotType, context, frameURL, opts)` — same pattern for DOM frame-snapshots
- `StartCaptureLoop(pageID, interval, format, quality)` — start continuous polling loop, feed ring buffer and optional stream/recorder
- `StopCaptureLoop()` — stop the polling loop
- `Drain()` — `inflightWg.Wait()`, blocks until all in-flight screenshots complete
- `Close()` — stop capture loop, close `stopChan`, then close the WebSocket connection

### Lifecycle

1. **Creation**: Lazy — opened on `recording.start` with `screenshots: true`. No second connection for sessions that never record.
2. **WebSocket URL**: Stored on `BrowserSession` as `wsURL` field, set during `OnClientConnect` from `launchResult.WebSocketURL` (local) or `r.connectURL` (remote).
3. **Read loop**: Routes BiDi responses by command ID. Discards events (main channel handles those).
4. **Drain**: `mc.Drain()` blocks until all in-flight screenshots complete. Called by `handleRecordingStop` before building the zip.
5. **Close**: Closes `stopChan`, then closes the WebSocket.
6. **Session teardown**: Media channel closed in `closeSession()`.

### Changes to `dispatch()`

| Aspect | Before | After |
|--------|--------|-------|
| Screenshot channel | Main BiDi connection | Dedicated media channel |
| Blocking | `CaptureRecordingScreenshot` blocks dispatch | `CaptureScreenshotAsync` returns immediately (or picks from ring buffer if capture loop is running) |
| `screenshotInFlight` | Atomic to prevent overlapping captures | Removed (media channel handles concurrency) |
| `dispatchMu` hold time | Includes screenshot wait | Releases after handler + fire-and-forget |
| `afterSnapshot` in RecordActionEnd | Synchronous snapshot name | Empty string (snapshot added async) |
| Frame source | One capture per action | Ring buffer nearest-match (when capture loop active) or async capture (Phase 1 without streaming) |

#### Before-snapshots

Keep before-snapshots on the main channel synchronously for the initial implementation. They only apply to interaction handlers (click, fill) and the ~2s timeout is already short.

### Recording start/stop integration

- `handleRecordingStart`: if `opts.Screenshots || opts.Snapshots` and `wsURL != ""`, call `OpenMediaChannel(wsURL)`, store on session. If streaming is active, the capture loop is already running — just hook the recorder into it. If `opts.AllFrames`, register the recorder to receive every frame from the loop.
- `handleRecordingStop`: `mc.Drain()` (wait for in-flight screenshots), `recorder.Stop()` (build zip). If no stream viewers remain, `mc.Close()`. Otherwise, unhook the recorder but keep the capture loop running for viewers.
- `closeSession`: close media channel if session torn down mid-recording

### Agent/MCP path integration

- `Handlers` struct gets `mediaChannel *MediaChannel` field
- `browserRecordStart`: open media channel
- `Call()`: use `h.mediaChannel.CaptureScreenshotAsync()` if available, else fall back to sync `CaptureRecordingScreenshot`
- `getWSURL()` helper: derives URL from `connectURL` or `launchResult`

### Graceful fallback

If media channel fails to open (nil check), fall back to current synchronous behavior. Log a warning, no error to the client. `screenshotInFlight` stays on `BrowserSession` for the fallback path.

### Wire format (BiDi on media channel)

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

### Frame retention modes

Three tiers of frame retention, controlled by recording options:

```json
recording.start({
  "screenshots": true,
  "allFrames": false,
  "video": null
})
```

| Option | Default | Behavior |
|--------|---------|----------|
| `screenshots: true` | — | Enable screenshot capture on the media channel |
| `allFrames: false` | `false` | **Action-only**: one frame per action, cherry-picked from ring buffer by nearest timestamp. Small zip, same density as today. |
| `allFrames: true` | — | **All frames**: every capture-loop frame goes into the zip as a `screencast-frame` event. Smooth filmstrip scrubbing in Record Player. |
| `video: "path.mp4"` | `null` | **Video export** (Phase 3): encode frames to MP4/WebM file as they arrive. Useful for CI reports, bug reports, sharing. |

#### Action-only (default)

`dispatch()` calls `ringBuffer.Nearest(endTime)` → feeds one frame to `recorder.AddScreenshot()`. Capture loop keeps running for streaming viewers (if any) but frames not sent to the recorder are discarded from the ring buffer as it wraps.

Zip size: ~1 frame per action × 50KB ≈ a few hundred KB for a typical test.

#### All frames

The capture loop feeds **every frame** to `recorder.AddScreenshot()` in addition to broadcasting to stream viewers. The ring buffer still exists for `Nearest()` lookups but every frame also goes to the recorder.

Zip size: 300 frames × 50KB = ~15MB for a 30s recording at 10fps. Acceptable. Quality and interval are tunable.

When streaming is also active, the capture loop serves double duty — frames go to both the recorder and connected stream viewers.

#### Video export (Phase 3)

A `VideoEncoder` goroutine consumes frames from the capture loop and writes to an MP4/WebM file using ffmpeg (shelled out) or a Go encoding library. Runs alongside the recorder — the zip still gets `screencast-frame` events, and the video file is written separately.

```go
type VideoEncoder struct {
    cmd    *exec.Cmd   // ffmpeg process
    stdin  io.WriteCloser
    format string      // "mp4" or "webm"
    fps    int
}
```

Activated by `recording.start({ video: "output.mp4" })` or `vibium record --video output.mp4`. The encoder receives raw JPEG frames and pipes them to ffmpeg's stdin as a MJPEG stream. ffmpeg handles the rest (re-encoding, muxing, container format).

### Memory considerations

Ring buffer holds the last N frames (default 30 = ~3s at 10fps). At 50KB per frame, that's ~1.5MB. The buffer wraps — old frames are overwritten, not accumulated. Only `allFrames` mode accumulates frames in the recorder's resource map.

## Part 2: Live Streaming (Phase 2)

Stream the browser viewport via WebSocket for live preview or "pair browsing" where a human can watch and interact alongside an AI agent.

### Activation

```bash
# Environment variable
VIBIUM_STREAM_PORT=9223 vibium start

# Or CLI flag
vibium start --stream-port 9223
```

When set, vibium starts a WebSocket server on the given port. Clients connect to `ws://localhost:9223` to receive frames and send input.

The streaming server uses the media channel's second BiDi connection. If recording is also active, both share the same media channel — the capture loop serves double duty, feeding frames to both the recorder and connected stream viewers.

### Capture loop and ring buffer

Since BiDi has no native push-based screencast, the media channel runs a **polling loop** that feeds a **ring buffer**:

```
capture loop (every <interval>):
    browsingContext.captureScreenshot on media channel
    → decode base64
    → store in ring buffer (last N frames, each tagged with timestamp)
    → broadcast to connected stream viewers (every frame)
    → if allFrames recording, also feed every frame to recorder.AddScreenshot()
```

Default interval: 100ms (~10 fps). Configurable via streaming options. The loop runs on the media channel's second BiDi connection, so it never blocks automation commands on the main channel.

When `dispatch()` completes an action, it grabs the **nearest frame by timestamp** from the ring buffer and feeds it to the recorder. No new capture request needed — the frame is already there.

```go
type FrameBuffer struct {
    mu     sync.RWMutex
    frames []*CapturedFrame // circular buffer
    size   int              // max frames to keep (e.g. 30 = ~3s at 10fps)
    head   int              // write position
}

type CapturedFrame struct {
    Data      []byte
    Width     int
    Height    int
    PageID    string
    Timestamp time.Time
}
```

`FrameBuffer.Nearest(ts time.Time) *CapturedFrame` returns the frame closest to the given timestamp. Used by `dispatch()` to pick the right frame for a completed action without issuing a new capture.

### WebSocket protocol: server → client

#### Frame messages

```json
{
  "type": "frame",
  "data": "<base64-encoded-jpeg>",
  "metadata": {
    "width": 1280,
    "height": 720,
    "pageId": "ABC123",
    "timestamp": 1708000000100
  }
}
```

| Field | Type | Description |
|-------|------|-------------|
| `type` | `"frame"` | Frame message identifier |
| `data` | string | Base64-encoded JPEG or PNG image data |
| `metadata.width` | number | Viewport width in pixels |
| `metadata.height` | number | Viewport height in pixels |
| `metadata.pageId` | string | BiDi browsing context ID of the captured page |
| `metadata.timestamp` | number | Unix timestamp in milliseconds |

#### Status messages

Sent on connect and when screencast state changes:

```json
{
  "type": "status",
  "connected": true,
  "streaming": true,
  "width": 1280,
  "height": 720,
  "pageId": "ABC123"
}
```

### WebSocket protocol: client → server (remote input)

Stream viewers can inject input events. Each message maps to a BiDi `input.performActions` command sent on the media channel.

#### Mouse events

```json
{
  "type": "input_mouse",
  "eventType": "mousePressed",
  "x": 100,
  "y": 200,
  "button": "left",
  "clickCount": 1
}
```

| `eventType` | BiDi action | Notes |
|-------------|-------------|-------|
| `mousePressed` | `pointerDown` | `button`: `"left"`, `"right"`, `"middle"` |
| `mouseReleased` | `pointerUp` | |
| `mouseMoved` | `pointerMove` | |
| `mouseWheel` | `scroll` (wheel source) | `deltaX`, `deltaY` fields |

Translation to BiDi:

```json
{
  "method": "input.performActions",
  "params": {
    "context": "<active browsing context>",
    "actions": [{
      "type": "pointer",
      "id": "stream-mouse",
      "parameters": {"pointerType": "mouse"},
      "actions": [
        {"type": "pointerMove", "x": 100, "y": 200},
        {"type": "pointerDown", "button": 0}
      ]
    }]
  }
}
```

#### Keyboard events

```json
{
  "type": "input_keyboard",
  "eventType": "keyDown",
  "key": "Enter",
  "code": "Enter"
}
```

| `eventType` | BiDi action |
|-------------|-------------|
| `keyDown` | `keyDown` |
| `keyUp` | `keyUp` |
| `char` | `keyDown` + `keyUp` (single character) |

Translation to BiDi:

```json
{
  "method": "input.performActions",
  "params": {
    "context": "<active browsing context>",
    "actions": [{
      "type": "key",
      "id": "stream-keyboard",
      "actions": [
        {"type": "keyDown", "value": "\uE007"}
      ]
    }]
  }
}
```

Key names are mapped to BiDi key values (e.g. `"Enter"` → `"\uE007"`, `"Tab"` → `"\uE004"`).

#### Touch events

```json
{
  "type": "input_touch",
  "eventType": "touchStart",
  "touchPoints": [{"x": 100, "y": 200, "id": 0}]
}
```

| `eventType` | BiDi action |
|-------------|-------------|
| `touchStart` | `pointerDown` with `pointerType: "touch"` |
| `touchMove` | `pointerMove` with `pointerType: "touch"` |
| `touchEnd` | `pointerUp` with `pointerType: "touch"` |

Multi-touch (pinch zoom) maps to multiple pointer sources, each with a unique `id`.

#### Modifier bitmask

For keyboard modifiers on mouse/keyboard events:

| Bit | Modifier |
|-----|----------|
| 1 | Alt |
| 2 | Ctrl |
| 4 | Meta |
| 8 | Shift |

### Input safety

Remote input from stream viewers is sent on the **media channel**, not the main channel. This means:

- Automation commands and remote input never contend for the same WebSocket write lock
- If an AI agent is running actions on the main channel, a human can still interact via the stream
- Command ID ranges stay separate (media channel: 2,000,000+)

### Concurrent viewers

Multiple WebSocket clients can connect to the stream port simultaneously. All receive the same frame broadcast. Input from any viewer is forwarded to the browser (last-writer-wins — no input arbitration in v1).

### New file: `clicker/internal/api/stream.go`

```go
type StreamServer struct {
    mu       sync.RWMutex
    clients  map[*websocket.Conn]struct{}
    media    *MediaChannel
    interval time.Duration
    format   string    // "jpeg" or "png"
    quality  float64   // 0.0–1.0
    pageID   string    // active browsing context
    stopChan chan struct{}
}
```

Key methods:

- `NewStreamServer(media *MediaChannel, opts StreamOptions) *StreamServer`
- `Start(addr string) error` — start HTTP server with WebSocket upgrade at `/`
- `SetActivePage(pageID string)` — switch which context is captured
- `handleConnection(conn *websocket.Conn)` — send status, start reading input
- `captureLoop()` — poll `browsingContext.captureScreenshot` on media channel, broadcast to clients
- `relayInput(msg InputMessage)` — translate to BiDi `input.performActions`, send on media channel
- `Stop()` — stop capture loop, close all client connections

### CLI integration

```go
// In main.go or daemon start
var streamPort int // from --stream-port flag or VIBIUM_STREAM_PORT env

// In session setup, after media channel is opened
if streamPort > 0 {
    stream := NewStreamServer(mediaChannel, StreamOptions{
        Format:   "jpeg",
        Quality:  0.5,
        Interval: 100 * time.Millisecond,
    })
    go stream.Start(fmt.Sprintf(":%d", streamPort))
}
```

### Programmatic API (JS client)

```typescript
const bro = await browser.start({ streamPort: 9223 });
const page = await bro.page();

// Stream is automatically available at ws://localhost:9223
// External viewers connect and see the browser in real-time
// while the AI agent automates via the normal API

await page.go("https://example.com");
await page.find("button").click();
// Human watching the stream can also click, type, scroll
```

## Files to modify

### Phase 1 (async recording)

| File | Changes |
|------|---------|
| `clicker/internal/api/media.go` | **New file.** MediaChannel struct, OpenMediaChannel, readLoop, SendCommand, CaptureScreenshotAsync, StartCaptureLoop, StopCaptureLoop, FrameBuffer, Drain, Close |
| `clicker/internal/api/router.go` | Add `mediaChannel` and `wsURL` to BrowserSession. Set `wsURL` in OnClientConnect. Close in closeSession. Modify dispatch() for async screenshots |
| `clicker/internal/api/handlers_recording.go` | Open media channel in handleRecordingStart. Drain + close in handleRecordingStop and handleRecordingStopChunk |
| `clicker/internal/agent/handlers.go` | Add `mediaChannel` to Handlers. Open in browserRecordStart, drain+close in browserRecordStop. Async screenshots in Call(). Add getWSURL() helper |

### Phase 2 (streaming + remote input)

| File | Changes |
|------|---------|
| `clicker/internal/api/stream.go` | **New file.** StreamServer struct, WebSocket server, capture loop, input relay |
| `clicker/internal/api/router.go` | Start stream server if `streamPort` is set |
| `clicker/cmd/clicker/main.go` | Add `--stream-port` flag, read `VIBIUM_STREAM_PORT` env |
| `clients/javascript/src/clicker/browser.ts` | Add `streamPort` option to `browser.start()` |
| `clients/python/src/vibium/browser.py` | Add `stream_port` option to `browser.start()` |

### Phase 3 (video export)

| File | Changes |
|------|---------|
| `clicker/internal/api/video.go` | **New file.** VideoEncoder struct, ffmpeg pipe, Start/Stop/WriteFrame |
| `clicker/internal/api/handlers_recording.go` | Start video encoder in handleRecordingStart if `opts.Video` set. Stop + finalize in handleRecordingStop |
| `clicker/internal/api/recording.go` | Add `Video string` and `AllFrames bool` to `RecordingStartOptions` |

## Verification

### Phase 1

1. `make test` — all existing tests pass
2. **Performance**: re-run saucedemo benchmark, expect Vibium recording time to drop from ~28s to ~14–15s
3. **Correctness**: inspect zip — `trace.trace` has `screencast-frame` events, `resources/` has screenshots, frame-snapshot events have correct linkage
4. **Filmstrip density**: more frames than before (continuous vs per-action)
5. **Drain**: rapid actions + immediate stop — all pending frames present in zip
6. **Fallback**: force media channel failure, verify sync fallback works
7. **Leak**: close session mid-recording, verify goroutines cleaned up

### Phase 2

1. **Frame delivery**: connect WebSocket client, verify JPEG frames arrive at ~10fps
2. **Mouse input**: send `mousePressed`/`mouseReleased`, verify click registers in browser via BiDi `input.performActions`
3. **Keyboard input**: send `keyDown`/`keyUp`, verify keystrokes register
4. **Touch input**: send `touchStart`/`touchMove`/`touchEnd`, verify touch events register
5. **Concurrent viewers**: connect 2+ clients, both receive frames, both can send input
6. **Recording + streaming**: enable both simultaneously, verify zip has frames and stream viewers get live output
7. **Cleanup**: stop daemon, verify WebSocket server shuts down and all goroutines exit

### Phase 3

1. **allFrames zip**: enable `allFrames: true`, run saucedemo E2E, verify zip has ~300 `screencast-frame` events (not just ~20 action frames)
2. **Video output**: `recording.start({ video: "out.mp4" })`, verify MP4 file is written, playable, correct duration
3. **Video + recording**: both zip and MP4 produced simultaneously
4. **ffmpeg missing**: graceful error if ffmpeg not installed when `video` option is used

## Use cases

- **Pair browsing** — human watches and assists AI agent in real-time
- **Remote preview** — view browser output in a separate UI (web dashboard, IDE panel)
- **Screen sharing** — share what the agent sees with teammates
- **Manual intervention** — human takes over when the agent gets stuck, then hands back control
- **Mobile testing** — inject touch events for mobile emulation testing
- **Recording filmstrip** — `allFrames: true` for smoother playback in Record Player
- **Video export** — `video: "test.mp4"` for CI reports, bug reports, demos
- **Combined** — record zip (for Record Player) + video (for sharing) + stream (for live viewing) all at once
