"""
tobii_bridge.py — Tobii Stream Engine → WebSocket Bridge (Hot-Pluggable)
========================================================================
Uses the tobii_stream_engine.dll (installed by Tobii Experience / EyeX) via
ctypes to subscribe to gaze data from the Tobii Eye Tracker 5, then streams
normalized gaze points as JSON over a local WebSocket server.

WebSocket server: ws://127.0.0.1:7070
Message format:  {"x": float, "y": float, "timestamp": int, "valid": bool}
Or connection status messages: {"status": "connected" | "disconnected"}

Latency design:
  The Tobii DLL calls _gaze_point_callback on its own internal thread at
  ~90 Hz.  Instead of the old "last-write + poll every 11 ms" model, we use
  call_soon_threadsafe to push each frame immediately into the asyncio event
  loop as it arrives.  The asyncio send coroutine then delivers it to all
  WebSocket clients without waiting for the next sleep cycle.
  This removes the ~0–11 ms polling jitter from the pipeline.

Hot-plugging design:
  - Spawns the WebSocket server immediately on startup, letting the Node.js
    side connect successfully even if no tracker is plugged in yet.
  - Finder Task: In the background, a low-energy task queries local device URLs
    every 2.0 seconds (using asyncio.sleep, which consumes 0.00% CPU / energy).
  - Reconnection & FFI Cleanup: If connection is lost or unplugged during operation,
    the polling thread detects the error, gracefully unsubscribes/destroys the 
    device pointers on the main loop, alerts all WebSocket clients, and restarts 
    the Finder Task.
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

# ─── Robust standard streams wrapping for GUI/compiled environment ────────────
class SafeStreamWrapper:
    def __init__(self, stream):
        self._stream = stream

    def write(self, data):
        if self._stream is None:
            return
        try:
            self._stream.write(data)
        except Exception:
            pass

    def flush(self):
        if self._stream is None:
            return
        try:
            self._stream.flush()
        except Exception:
            pass

    def isatty(self):
        return False

    def readable(self):
        return False

    def writable(self):
        return True

    def seekable(self):
        return False

    @property
    def encoding(self):
        try:
            return self._stream.encoding if self._stream else "utf-8"
        except Exception:
            return "utf-8"

    @property
    def errors(self):
        try:
            return self._stream.errors if self._stream else "strict"
        except Exception:
            return "strict"

    def __getattr__(self, name):
        if self._stream is None:
            raise AttributeError(name)
        try:
            attr = getattr(self._stream, name)
        except Exception:
            raise AttributeError(name)
        if callable(attr):
            def safe_wrapper(*args, **kwargs):
                try:
                    return attr(*args, **kwargs)
                except (OSError, IOError, ValueError):
                    return None
            return safe_wrapper
        return attr

sys.stdout = SafeStreamWrapper(sys.stdout)
sys.stderr = SafeStreamWrapper(sys.stderr)

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

TOBII_ERROR_NO_ERROR           = 0
TOBII_ERROR_NOT_SUPPORTED      = 1
TOBII_ERROR_NOT_AVAILABLE      = 2
TOBII_ERROR_CONNECTION_FAILED  = 3
TOBII_ERROR_TIMED_OUT          = 6

# Soft-reconnect: consecutive poll failures before we escalate to full device destroy+create.
# A single transient error (e.g. short USB hiccup) should be recovered with a resubscribe;
# only after this many consecutive failures do we destroy the device handle (which cuts IR power).
_SOFT_RECONNECT_MAX_FAILS = 3

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

# FFI state & Hot-Plugging State Machine
_device_ptr = ctypes.c_void_p(None)
_device_state = 'disconnected'            # 'connected' | 'disconnected'
_stop_poll_event = None
_poll_thread_inst = None
_cb_ref = None
dll = None
api_ptr = None
_consecutive_poll_fails = 0               # counts consecutive poll errors for soft-reconnect logic

def _gaze_point_callback(gaze_point_ptr, user_data):
    """Called from Tobii's internal thread at ~90 Hz."""
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

def _enumerate_urls(dll_inst, api_inst):
    """Return list of device URL strings from the Tobii API."""
    urls = []

    ReceiveFn = ctypes.CFUNCTYPE(None, ctypes.c_char_p, ctypes.c_void_p)

    def receive_url(url_bytes, user_data):
        if url_bytes:
            urls.append(url_bytes.decode("utf-8"))

    cb = ReceiveFn(receive_url)
    ret = dll_inst.tobii_enumerate_local_device_urls(api_inst, cb, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_enumerate_local_device_urls returned {ret}", file=sys.stderr)
    return urls

# ─── WebSocket server ──────────────────────────────────────────────────────────

async def broadcast_status(status_str):
    """Notify all connected clients about connection status changes."""
    global _connected_clients
    if not _connected_clients:
        return
    msg = json.dumps({"status": status_str})
    dead = set()
    for ws in list(_connected_clients):
        try:
            await ws.send(msg)
        except Exception:
            dead.add(ws)
    _connected_clients.difference_update(dead)

async def _ws_handler(websocket):
    """Each new WebSocket client connection."""
    global _device_state
    _connected_clients.add(websocket)
    print(f"[tobii_bridge] Client connected: {websocket.remote_address}", flush=True)
    
    # Sync current device connection state immediately to the client
    try:
        await websocket.send(json.dumps({"status": _device_state}))
    except Exception as e:
        print(f"[tobii_bridge] Failed to send initial status to client: {e}", file=sys.stderr)

    try:
        async for _ in websocket:
            pass  # We ignore inbound messages
    except websockets.exceptions.ConnectionClosed:
        pass
    finally:
        _connected_clients.discard(websocket)
        print(f"[tobii_bridge] Client disconnected: {websocket.remote_address}", flush=True)

async def _broadcaster(stop_event):
    """Drain the gaze queue and push each frame to all connected clients."""
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

# ─── Device Connection / Disconnection State Machine ──────────────────────────

def _connect_device(device_url_str):
    """Initializes and subscribes to a specific Tobii eye tracker device."""
    global _device_ptr, _device_state, _cb_ref, _stop_poll_event, _poll_thread_inst, dll, api_ptr
    device_url = device_url_str.encode("utf-8")

    # Allocate a local pointer to create a stable Python closure cell
    device_ptr = ctypes.c_void_p(None)

    ret = dll.tobii_device_create(api_ptr, ctypes.c_char_p(device_url), 1, ctypes.byref(device_ptr))
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_device_create failed: {ret}", file=sys.stderr, flush=True)
        return False
    print(f"[tobii_bridge] Device created: {device_url_str}", flush=True)

    # Brief stabilisation pause: after tobii_device_create the hardware needs a moment
    # to power up its IR emitter array before we subscribe. Without this, the first
    # subscribe call after a destroy/create cycle may succeed but produce no gaze frames
    # because the IR hardware isn't ready yet.
    time.sleep(0.5)

    _cb_ref = GazePointCallbackType(_gaze_point_callback)  # keep alive!
    ret = dll.tobii_gaze_point_subscribe(device_ptr, _cb_ref, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_gaze_point_subscribe failed: {ret}", file=sys.stderr, flush=True)
        dll.tobii_device_destroy(device_ptr)
        return False
    print("[tobii_bridge] Subscribed to gaze point data.", flush=True)

    _device_ptr = device_ptr
    _device_state = 'connected'
    _stop_poll_event = threading.Event()

    # Define poll thread inside so it closes over local 'device_ptr' directly
    def _poll_thread():
        global _stop_poll_event, _consecutive_poll_fails
        _consecutive_poll_fails = 0
        print("[tobii_bridge] Device poll thread started.", flush=True)
        while not _stop_poll_event.is_set():
            if device_ptr is None or device_ptr.value is None:
                break
            
            # Wait up to 1 second for a callback to arrive (argtypes ensures correct FFI pointer conversion)
            ret_wait = dll.tobii_wait_for_callbacks(1, ctypes.byref(device_ptr))
            if ret_wait not in (0, TOBII_ERROR_TIMED_OUT):  # 0: NO_ERROR, 6: TIMED_OUT (normal for no gaze)
                _consecutive_poll_fails += 1
                print(
                    f"[tobii_bridge] tobii_wait_for_callbacks failed: {ret_wait} "
                    f"(consecutive fails: {_consecutive_poll_fails})",
                    file=sys.stderr, flush=True
                )
                if _consecutive_poll_fails < _SOFT_RECONNECT_MAX_FAILS:
                    # Transient error — try a soft resubscribe to avoid destroying the device
                    # (destroying the handle cuts IR power; resubscribing keeps it on).
                    print("[tobii_bridge] Attempting soft resubscribe (keep IR on)…", flush=True)
                    _loop.call_soon_threadsafe(_trigger_soft_reconnect)
                    # Give the main loop time to issue the resubscribe before continuing poll
                    time.sleep(0.2)
                    continue
                else:
                    # Too many consecutive failures — escalate to full disconnect+reconnect
                    print("[tobii_bridge] Too many consecutive failures — triggering full disconnect.", flush=True)
                    _trigger_disconnect()
                    break
            else:
                _consecutive_poll_fails = 0  # reset on success

            # Synchronously process pending callbacks (fires ctypes callback on this thread)
            ret_proc = dll.tobii_device_process_callbacks(device_ptr)
            if ret_proc != TOBII_ERROR_NO_ERROR:
                _consecutive_poll_fails += 1
                print(
                    f"[tobii_bridge] tobii_device_process_callbacks failed: {ret_proc} "
                    f"(consecutive fails: {_consecutive_poll_fails})",
                    file=sys.stderr, flush=True
                )
                if _consecutive_poll_fails < _SOFT_RECONNECT_MAX_FAILS:
                    print("[tobii_bridge] Attempting soft resubscribe (keep IR on)…", flush=True)
                    _loop.call_soon_threadsafe(_trigger_soft_reconnect)
                    time.sleep(0.2)
                    continue
                else:
                    print("[tobii_bridge] Too many consecutive failures — triggering full disconnect.", flush=True)
                    _trigger_disconnect()
                    break
            else:
                _consecutive_poll_fails = 0  # reset on success
        print("[tobii_bridge] Device poll thread stopped.", flush=True)

    _poll_thread_inst = threading.Thread(target=_poll_thread, daemon=True)
    _poll_thread_inst.start()

    # Alert connected clients immediately
    asyncio.run_coroutine_threadsafe(broadcast_status("connected"), _loop)
    return True

def _trigger_disconnect():
    """Triggers the thread-safe full disconnect handler in the main asyncio loop."""
    global _loop
    if _loop is not None:
        _loop.call_soon_threadsafe(_handle_disconnect)

def _trigger_soft_reconnect():
    """Triggers the thread-safe soft reconnect (resubscribe only) in the main asyncio loop."""
    global _loop
    if _loop is not None:
        _loop.call_soon_threadsafe(_handle_soft_reconnect)

def _handle_soft_reconnect():
    """Tries to resubscribe to gaze data WITHOUT destroying the device handle.
    This keeps the IR emitters powered on. Falls back to full disconnect if it fails."""
    global _device_ptr, _device_state, _cb_ref, _consecutive_poll_fails
    if _device_state != 'connected':
        return
    if _device_ptr is None or _device_ptr.value is None:
        _handle_disconnect()
        return

    print("[tobii_bridge] Soft reconnect: unsubscribing and resubscribing gaze point…", flush=True)
    try:
        dll.tobii_gaze_point_unsubscribe(_device_ptr)
    except Exception as e:
        print(f"[tobii_bridge] Soft reconnect: unsubscribe error: {e}", file=sys.stderr, flush=True)

    # Re-create the callback reference to avoid any stale closure
    _cb_ref = GazePointCallbackType(_gaze_point_callback)
    try:
        ret = dll.tobii_gaze_point_subscribe(_device_ptr, _cb_ref, None)
        if ret == TOBII_ERROR_NO_ERROR:
            _consecutive_poll_fails = 0
            print("[tobii_bridge] Soft reconnect: gaze resubscription successful.", flush=True)
            return
        else:
            print(f"[tobii_bridge] Soft reconnect: resubscribe failed ({ret}), escalating to full disconnect.", file=sys.stderr, flush=True)
    except Exception as e:
        print(f"[tobii_bridge] Soft reconnect: exception during resubscribe: {e}", file=sys.stderr, flush=True)

    # Soft reconnect failed — escalate to full destroy/create cycle
    _handle_disconnect()

def _handle_disconnect():
    """Cleans up the disconnected FFI resource handles and schedules the Finder Task."""
    global _device_ptr, _device_state, _stop_poll_event, _poll_thread_inst, _cb_ref, dll, api_ptr
    if _device_state != 'connected':
        return

    print("[tobii_bridge] Handling device disconnection...", flush=True)
    _device_state = 'disconnected'

    if _stop_poll_event is not None:
        _stop_poll_event.set()

    if _device_ptr is not None and _device_ptr.value is not None:
        try:
            dll.tobii_gaze_point_unsubscribe(_device_ptr)
        except Exception as e:
            print(f"[tobii_bridge] Error unsubscribing: {e}", file=sys.stderr)
        try:
            dll.tobii_device_destroy(_device_ptr)
        except Exception as e:
            print(f"[tobii_bridge] Error destroying device: {e}", file=sys.stderr)
        _device_ptr.value = None

    _cb_ref = None

    # Broadcast status change and restart searcher task
    asyncio.create_task(broadcast_status("disconnected"))
    asyncio.create_task(_connection_finder_task(dll, api_ptr))

async def _connection_finder_task(dll_inst, api_inst):
    """Background scanner task that queries local Tobii device URLs every 2 seconds."""
    global _device_state, api_ptr
    print("[tobii_bridge] Connection finder task started.", flush=True)
    attempts = 0
    while True:
        if _device_state == 'connected':
            break

        # On the very first attempt after a full disconnect, wait a moment before
        # trying to reconnect. This gives the Tobii driver time to release its
        # internal device state after tobii_device_destroy was called.
        # Without this pause, tobii_device_create may return a handle but the IR
        # emitters don't actually power back on.
        if attempts == 0:
            await asyncio.sleep(1.0)

        # Every 3 attempts (~6 seconds) of not finding any device, recreate the API pointer
        # to clear any cached driver state and force a clean re-query of the Tobii service.
        if attempts > 0 and attempts % 3 == 0:
            print("[tobii_bridge] Re-initializing Tobii API context to refresh device state...", flush=True)
            try:
                if api_ptr is not None and api_ptr.value is not None:
                    dll_inst.tobii_api_destroy(api_ptr)
                    api_ptr = None
            except Exception as e:
                print(f"[tobii_bridge] Error destroying API: {e}", file=sys.stderr, flush=True)
            
            try:
                api_ptr = ctypes.c_void_p(None)
                ret = dll_inst.tobii_api_create(ctypes.byref(api_ptr), None, None)
                if ret != TOBII_ERROR_NO_ERROR:
                    print(f"[tobii_bridge] tobii_api_create failed during re-init: {ret}", file=sys.stderr, flush=True)
                    api_ptr = None
            except Exception as e:
                print(f"[tobii_bridge] Exception during API re-init: {e}", file=sys.stderr, flush=True)
                api_ptr = None

        current_api = api_ptr if api_ptr is not None else api_inst
        if current_api is not None:
            urls = _enumerate_urls(dll_inst, current_api)
            if urls:
                print(f"[tobii_bridge] Connection finder found tracker: {urls[0]}", flush=True)
                ok = _connect_device(urls[0])
                if ok:
                    break

        attempts += 1
        # Yield event loop. Uses 0% CPU and zero power.
        await asyncio.sleep(2.0)
    print("[tobii_bridge] Connection finder task stopped.", flush=True)


def _declare_ffi_signatures(dll_inst):
    """Declares the ctypes argtypes and restypes for all used Tobii SDK functions.
    This is critical on 64-bit Windows/Python to prevent pointer truncation crashes.
    """
    try:
        # tobii_error_t tobii_api_create( tobii_api_t** api, tobii_custom_allocator_t const* custom_allocator, tobii_custom_log_t const* custom_log );
        dll_inst.tobii_api_create.argtypes = [ctypes.POINTER(ctypes.c_void_p), ctypes.c_void_p, ctypes.c_void_p]
        dll_inst.tobii_api_create.restype = ctypes.c_int

        # tobii_error_t tobii_api_destroy( tobii_api_t* api );
        dll_inst.tobii_api_destroy.argtypes = [ctypes.c_void_p]
        dll_inst.tobii_api_destroy.restype = ctypes.c_int

        # tobii_error_t tobii_enumerate_local_device_urls( tobii_api_t* api, tobii_device_url_receiver_t receiver, void* user_data );
        dll_inst.tobii_enumerate_local_device_urls.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        dll_inst.tobii_enumerate_local_device_urls.restype = ctypes.c_int

        # tobii_error_t tobii_device_create( tobii_api_t* api, char const* url, tobii_field_of_use_t field_of_use, tobii_device_t** device );
        dll_inst.tobii_device_create.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
        dll_inst.tobii_device_create.restype = ctypes.c_int

        # tobii_device_destroy( tobii_device_t* device );
        dll_inst.tobii_device_destroy.argtypes = [ctypes.c_void_p]
        dll_inst.tobii_device_destroy.restype = ctypes.c_int

        # tobii_error_t tobii_gaze_point_subscribe( tobii_device_t* device, tobii_gaze_point_callback_t callback, void* user_data );
        dll_inst.tobii_gaze_point_subscribe.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
        dll_inst.tobii_gaze_point_subscribe.restype = ctypes.c_int

        # tobii_error_t tobii_gaze_point_unsubscribe( tobii_device_t* device );
        dll_inst.tobii_gaze_point_unsubscribe.argtypes = [ctypes.c_void_p]
        dll_inst.tobii_gaze_point_unsubscribe.restype = ctypes.c_int

        # tobii_error_t tobii_wait_for_callbacks( int device_count, tobii_device_t* const* devices );
        dll_inst.tobii_wait_for_callbacks.argtypes = [ctypes.c_int, ctypes.POINTER(ctypes.c_void_p)]
        dll_inst.tobii_wait_for_callbacks.restype = ctypes.c_int

        # tobii_error_t tobii_device_process_callbacks( tobii_device_t* device );
        dll_inst.tobii_device_process_callbacks.argtypes = [ctypes.c_void_p]
        dll_inst.tobii_device_process_callbacks.restype = ctypes.c_int
    except Exception as e:
        print(f"[tobii_bridge] Warning: Failed to declare some FFI signatures: {e}", file=sys.stderr, flush=True)


# ─── Main ─────────────────────────────────────────────────────────────────────

async def _main():
    global _loop, _gaze_queue, dll, api_ptr, _device_ptr, _device_state
    _loop = asyncio.get_running_loop()
    _gaze_queue = asyncio.Queue(maxsize=4)

    # ── 1. Load DLL ──────────────────────────────────────────────────────────
    dll, dll_path = _load_dll()
    if dll is None:
        print("[tobii_bridge] ERROR: tobii_stream_engine.dll not found. "
              "Is Tobii Experience installed?", file=sys.stderr, flush=True)
        sys.exit(1)
    print(f"[tobii_bridge] Loaded DLL: {dll_path}", flush=True)
    _declare_ffi_signatures(dll)

    # ── 2. Create API ─────────────────────────────────────────────────────────
    api_ptr = ctypes.c_void_p(None)
    ret = dll.tobii_api_create(ctypes.byref(api_ptr), None, None)
    if ret != TOBII_ERROR_NO_ERROR:
        print(f"[tobii_bridge] tobii_api_create failed: {ret}", file=sys.stderr, flush=True)
        sys.exit(1)
    print("[tobii_bridge] API created.", flush=True)

    # ── 3. Start WebSocket server ─────────────────────────────────────────────
    stop_event = asyncio.Event()

    # Handle OS signals for clean shutdown
    def _on_signal(*_):
        stop_event.set()

    for sig in (signal.SIGINT, signal.SIGTERM):
        try:
            _loop.add_signal_handler(sig, _on_signal)
        except (NotImplementedError, RuntimeError):
            pass  # Windows may not support add_signal_handler

    try:
        async with websockets.serve(_ws_handler, WS_HOST, WS_PORT):
            print(f"[tobii_bridge] Ready. Waiting for Electron client...", flush=True)
            
            # Start background device detector scan loop
            asyncio.create_task(_connection_finder_task(dll, api_ptr))
            
            await _broadcaster(stop_event)
    except OSError as e:
        if e.errno == 10048:
            print(f"[tobii_bridge] ERROR: Port {WS_PORT} is already in use by another process.", file=sys.stderr, flush=True)
            sys.exit(1)
        else:
            raise

    # ── 4. Cleanup ────────────────────────────────────────────────────────────
    print("[tobii_bridge] Shutting down…", flush=True)
    _device_state = 'disconnected'
    if _stop_poll_event is not None:
        _stop_poll_event.set()
    if _poll_thread_inst is not None:
        _poll_thread_inst.join(timeout=2)
    if _device_ptr is not None:
        try:
            dll.tobii_gaze_point_unsubscribe(_device_ptr)
        except Exception:
            pass
        try:
            dll.tobii_device_destroy(_device_ptr)
        except Exception:
            pass
        _device_ptr = None
    dll.tobii_api_destroy(api_ptr)
    print("[tobii_bridge] Done.", flush=True)


if __name__ == "__main__":
    asyncio.run(_main())
