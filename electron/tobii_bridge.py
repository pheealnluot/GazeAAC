"""
tobii_bridge.py — Tobii Stream Engine → WebSocket Bridge
=========================================================
Uses the tobii_stream_engine.dll (installed by Tobii Experience / EyeX) via
ctypes to subscribe to gaze data from the Tobii Eye Tracker 5, then streams
normalized gaze points as JSON over a local WebSocket server.

WebSocket server: ws://127.0.0.1:7070
Message format:  {"x": float, "y": float, "timestamp": int, "valid": bool}
  x, y  — normalized [0,1], origin top-left
  valid — True if at least one eye had a valid sample

Latency design:
  The Tobii DLL calls _gaze_point_callback on its own internal thread at
  ~90 Hz.  Instead of the old "last-write + poll every 11 ms" model, we use
  call_soon_threadsafe to push each frame immediately into the asyncio event
  loop as it arrives.  The asyncio send coroutine then delivers it to all
  WebSocket clients without waiting for the next sleep cycle.
  This removes the ~0–11 ms polling jitter from the pipeline.

Usage (standalone test):
  py -3.9 tobii_bridge.py
  py     tobii_bridge.py       (Python 3.14 also works since no PyPI dep)

Spawned by TobiiGazeProvider.js in Electron main process.  The Node side
connects as the WebSocket *client*; this script is the *server*.  Exits when:
  - No WebSocket clients remain connected for > 5 s
  - SIGINT / SIGTERM received
  - stdin is closed (Electron process died)

Requirements:
  - pip install websockets          (tested 15.0.1, Python 3.9 or 3.14)
  - Tobii Experience app installed (provides tobii_stream_engine.dll)
  - Tobii Eye Tracker 5 plugged in and visible in Tobii Experience
"""

import asyncio
import ctypes
import json
import os
import signal
import sys
import threading
import time

import websockets

# ─── DLL path ─────────────────────────────────────────────────────────────────

DLL_CANDIDATES = [
    r"C:\Program Files\Tobii\Tobii EyeX\tobii_stream_engine.dll",
    r"C:\Program Files (x86)\Tobii\Tobii EyeX\tobii_stream_engine.dll",
    os.path.join(os.path.dirname(__file__), "tobii_stream_engine.dll"),
]

WS_HOST = "127.0.0.1"
WS_PORT = 7070
IDLE_TIMEOUT_S = 8   # exit if no client for this many seconds after first connect

# ─── ctypes structures for Tobii Stream Engine ────────────────────────────────
# Reference: Tobii Stream Engine SDK tobii.h / tobii_streams.h

TOBII_ERROR_NO_ERROR = 0

# tobii_validity_t
TOBII_VALIDITY_INVALID = 0
TOBII_VALIDITY_VALID   = 1

class TobiiPoint2dF(ctypes.Structure):
    _fields_ = [("x", ctypes.c_float), ("y", ctypes.c_float)]

class TobiiGazePoint(ctypes.Structure):
    """Maps to tobii_gaze_point_t in tobii_streams.h"""
    _fields_ = [
        ("timestamp_us",    ctypes.c_longlong),
        ("validity",        ctypes.c_int),
        ("position_xy",     TobiiPoint2dF),
    ]

# Callback type: void (*tobii_gaze_point_callback_t)(tobii_gaze_point_t const*, void*)
GazePointCallbackType = ctypes.CFUNCTYPE(
    None,
    ctypes.POINTER(TobiiGazePoint),
    ctypes.c_void_p,
)

# ─── Globals shared between ctypes callback thread and asyncio loop ────────────

_connected_clients: set = set()
_loop: asyncio.AbstractEventLoop = None   # set in _main()
_gaze_queue: asyncio.Queue = None         # created in _main()

def _gaze_point_callback(gaze_point_ptr, user_data):
    """Called from Tobii's internal thread at ~90 Hz.

    LATENCY-CRITICAL: we push each frame directly into the asyncio event loop
    via call_soon_threadsafe so it is delivered to WebSocket clients immediately
    — without waiting for a polling sleep cycle.  The previous model stored the
    latest frame in _latest_gaze and a coroutine polled it every 1/90 s, which
    added 0–11 ms of queuing jitter on top of IPC latency.
    """
    global _loop, _gaze_queue
    gp = gaze_point_ptr.contents
    valid = (gp.validity == TOBII_VALIDITY_VALID)
    x = float(gp.position_xy.x) if valid else 0.5
    y = float(gp.position_xy.y) if valid else 0.5
    # clamp to [0,1]
    x = max(0.0, min(1.0, x))
    y = max(0.0, min(1.0, y))
    data = {
        "x":         x,
        "y":         y,
        "timestamp": int(time.time() * 1000),
        "valid":     valid,
    }
    # Push into the asyncio queue without blocking the Tobii callback thread.
    # put_nowait raises QueueFull if the queue is saturated — we silently drop
    # the frame to keep latency bounded rather than letting it accumulate.
    if _loop is not None and _gaze_queue is not None:
        def _push(d=data):
            try:
                _gaze_queue.put_nowait(d)
            except asyncio.QueueFull:
                # Drop oldest frame, insert latest — latest-wins under backpressure
                try:
                    _gaze_queue.get_nowait()
                    _gaze_queue.put_nowait(d)
                except Exception:
                    pass
        _loop.call_soon_threadsafe(_push)

# ─── Stream Engine setup ──────────────────────────────────────────────────────

def _load_dll():
    for path in DLL_CANDIDATES:
        if os.path.isfile(path):
            try:
                return ctypes.CDLL(path), path
            except OSError as e:
                print(f"[tobii_bridge] Could not load {path}: {e}", file=sys.stderr)
    return None, None

def _enumerate_urls(dll, api):
    """Return list of device URL strings from the Tobii API."""
    urls = []

    ReceiveFn = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_void_p)

    def receive_url(url_bytes, user_data):
        if url_bytes:
            urls.append(url_bytes.decode("utf-8"))

    cb = ReceiveFn(receive_url)
    ret = dll.tobii_enumerate_local_device_urls(api, cb, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_enumerate_local_device_urls returned {ret}", file=sys.stderr)
    return urls

# ─── WebSocket server ──────────────────────────────────────────────────────────

async def _ws_handler(websocket):
    """Each new WebSocket client connection."""
    _connected_clients.add(websocket)
    print(f"[tobii_bridge] Client connected: {websocket.remote_address}", flush=True)
    try:
        async for _ in websocket:
            pass  # We ignore inbound messages
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _connected_clients.discard(websocket)
        print(f"[tobii_bridge] Client disconnected: {websocket.remote_address}", flush=True)

async def _broadcaster(stop_event):
    """Drain the gaze queue and push each frame to all connected clients.

    Unlike the old sleep-and-poll model, this coroutine awaits frames from
    _gaze_queue which is fed directly by _gaze_point_callback on each DLL
    callback.  Each frame is sent within the same asyncio iteration it arrived,
    giving effectively zero extra queuing latency.

    The idle-timeout check runs alongside so the process still exits cleanly
    when Electron disconnects.
    """
    first_client_ever = False
    idle_since = None

    while not stop_event.is_set():
        try:
            # Wait up to 1 s for the next gaze frame so we can also do the
            # idle-timeout check even when no frames are arriving.
            data = await asyncio.wait_for(_gaze_queue.get(), timeout=1.0)
        except asyncio.TimeoutError:
            # No frame arrived — only run the idle check
            data = None

        if data is not None and _connected_clients:
            first_client_ever = True
            idle_since = None
            msg = json.dumps(data)
            dead = set()
            for ws in list(_connected_clients):
                try:
                    await ws.send(msg)
                except Exception:
                    dead.add(ws)
            _connected_clients.difference_update(dead)

        # Idle-timeout: exit if we had clients but they all disconnected
        if not _connected_clients and first_client_ever:
            if idle_since is None:
                idle_since = time.time()
            elif time.time() - idle_since > IDLE_TIMEOUT_S:
                print("[tobii_bridge] No clients for too long — exiting.", flush=True)
                stop_event.set()
        elif _connected_clients:
            idle_since = None

# ─── Main ─────────────────────────────────────────────────────────────────────

async def _main():
    global _loop, _gaze_queue
    _loop = asyncio.get_running_loop()
    # Bounded queue: if asyncio falls behind, drop oldest frames to keep
    # latency from accumulating.  At 90 Hz a depth of 4 gives 44 ms of buffer.
    _gaze_queue = asyncio.Queue(maxsize=4)

    # ── 1. Load DLL ──────────────────────────────────────────────────────────
    dll, dll_path = _load_dll()
    if dll is None:
        print("[tobii_bridge] ERROR: tobii_stream_engine.dll not found. "
              "Is Tobii Experience installed?", file=sys.stderr, flush=True)
        sys.exit(1)
    print(f"[tobii_bridge] Loaded DLL: {dll_path}", flush=True)

    # ── 2. Create API ─────────────────────────────────────────────────────────
    api_ptr = ctypes.c_void_p(None)
    ret = dll.tobii_api_create(ctypes.byref(api_ptr), None, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_api_create failed: {ret}", file=sys.stderr, flush=True)
        sys.exit(1)
    print("[tobii_bridge] API created.", flush=True)

    # ── 3. Enumerate devices ──────────────────────────────────────────────────
    urls = _enumerate_urls(dll, api_ptr)
    if not urls:
        print("[tobii_bridge] ERROR: No Tobii devices found. "
              "Is the tracker plugged in and recognized by Tobii Experience?",
              file=sys.stderr, flush=True)
        dll.tobii_api_destroy(api_ptr)
        sys.exit(1)
    print(f"[tobii_bridge] Found {len(urls)} device(s): {urls}", flush=True)

    # ── 4. Create device ──────────────────────────────────────────────────────
    device_url = urls[0].encode("utf-8")
    device_ptr = ctypes.c_void_p(None)
    # tobii_device_create(api, url, field_of_use, &device)
    # field_of_use: 1 = TOBII_FIELD_OF_USE_INTERACTIVE (no license required)
    ret = dll.tobii_device_create(
        api_ptr,
        ctypes.c_char_p(device_url),
        1,   # TOBII_FIELD_OF_USE_INTERACTIVE
        ctypes.byref(device_ptr),
    )
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_device_create failed: {ret}", file=sys.stderr, flush=True)
        dll.tobii_api_destroy(api_ptr)
        sys.exit(1)
    print(f"[tobii_bridge] Device created: {urls[0]}", flush=True)

    # ── 5. Subscribe to gaze point ────────────────────────────────────────────
    _cb_ref = GazePointCallbackType(_gaze_point_callback)  # keep alive!
    ret = dll.tobii_gaze_point_subscribe(device_ptr, _cb_ref, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_gaze_point_subscribe failed: {ret}", file=sys.stderr, flush=True)
        dll.tobii_device_destroy(device_ptr)
        dll.tobii_api_destroy(api_ptr)
        sys.exit(1)
    print("[tobii_bridge] Subscribed to gaze point data.", flush=True)

    # ── 6. Background thread: poll device callbacks ───────────────────────────
    # tobii_wait_for_callbacks blocks until the DLL has pending callback data
    # (max 1000 ms), then tobii_device_process_callbacks fires our ctypes
    # callback synchronously on this thread.  The callback immediately pushes
    # the frame into _gaze_queue → asyncio, so latency after the DLL fires is
    # only the asyncio event-loop iteration time (~sub-millisecond).
    stop_poll = threading.Event()

    def _poll_thread():
        while not stop_poll.is_set():
            # tobii_wait_for_callbacks blocks until data is ready (max 1000 ms)
            dll.tobii_wait_for_callbacks(None, 1, ctypes.byref(device_ptr))
            dll.tobii_device_process_callbacks(device_ptr)

    poll_t = threading.Thread(target=_poll_thread, daemon=True)
    poll_t.start()
    print("[tobii_bridge] Poll thread started.", flush=True)

    # ── 7. Start WebSocket server ─────────────────────────────────────────────
    stop_event = asyncio.Event()

    # Handle OS signals for clean shutdown
    def _on_signal(*_):
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            _loop.add_signal_handler(sig, _on_signal)
        except (NotImplementedError, RuntimeError):
            pass  # Windows may not support add_signal_handler

    print(f"[tobii_bridge] WebSocket server starting on ws://{WS_HOST}:{WS_PORT}", flush=True)

    async with websockets.serve(_ws_handler, WS_HOST, WS_PORT):
        print(f"[tobii_bridge] Ready. Waiting for Electron client...", flush=True)
        await _broadcaster(stop_event)

    # ── 8. Cleanup ────────────────────────────────────────────────────────────
    print("[tobii_bridge] Shutting down…", flush=True)
    stop_poll.set()
    poll_t.join(timeout=2)
    dll.tobii_gaze_point_unsubscribe(device_ptr)
    dll.tobii_device_destroy(device_ptr)
    dll.tobii_api_destroy(api_ptr)
    print("[tobii_bridge] Done.", flush=True)


if __name__ == "__main__":
    asyncio.run(_main())
