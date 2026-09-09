"""
MEETING DETECTION - the reason the user never has to press Start.

The signal, verified on this machine by holding the microphone open and
watching the session table:

    A process holds an ACTIVE session on the CAPTURE (microphone) endpoint.

That rule does the work. Spotify, YouTube, Netflix and a notification chime all
open the RENDER endpoint and none of them open the microphone, so watching the
speakers alone would fire on every song. Watching the microphone is very nearly
sufficient by itself, and the render session is kept as a corroborating signal
rather than a requirement, because a fully-muted participant is still in a
meeting and must still be recorded.

WHY THIS IS NOT AN ALLOW-LIST ANY MORE.

The first version only recorded processes on a hardcoded list of meeting apps.
It missed a real call and said nothing for two minutes, which is the worst of
both worlds: no recording, and no explanation. An allow-list has to be complete
to work, and it can never be complete - Teams alone ships as ms-teams.exe,
Teams.exe and msteams.exe across builds, browsers hand audio to differently
named child processes, and every corporate VDI client is its own binary.

So the logic is inverted. ANY process holding the microphone is a candidate,
except a small DENY list of things that are definitely not meetings. The
failure modes are then:

    old: miss the meeting entirely, silently          <- unrecoverable
    new: record something that was not a meeting      <- one click to discard

Known apps are still recognised, and reported with higher confidence, so the
distinction survives where it is useful.

Two pycaw quirks found by probing, both worked around here:

  1. `AudioUtilities.GetSpeakers()` returns a wrapped `AudioDevice` with no
     `.Activate`, while `GetMicrophone()` returns a raw IMMDevice. Going
     through `GetDeviceEnumerator()` gives a raw IMMDevice for BOTH.
  2. `GetSession(i)` yields an `IAudioSessionControl`, which has no
     `GetProcessId`. It must be QueryInterface'd to `IAudioSessionControl2`.
"""
import os

from comtypes import CLSCTX_ALL
from pycaw.constants import DEVICE_STATE, EDataFlow, ERole
from pycaw.pycaw import IAudioSessionControl2, IAudioSessionManager2
from pycaw.utils import AudioUtilities

from . import config
from .winproc import process_name, window_title

STATE_ACTIVE = 1

# Things that hold the microphone and are NOT a meeting. Kept deliberately
# short: everything not named here is treated as a possible meeting, because
# missing a real one is the failure that cannot be recovered from.
#
# The agent's own process is excluded by PID, not by name - it opens the
# microphone to record, so without that it would detect itself and never stop.
NOT_A_MEETING = {
    "voice.exe", "voiceaccess.exe", "cortana.exe", "searchapp.exe",
    "audiodg.exe", "shellexperiencehost.exe", "gamebar.exe",
    "gamebarpresencewriter.exe", "nvcontainer.exe", "obs64.exe", "obs32.exe",
    "soundrecorder.exe", "voicerecorder.exe",
}


def _endpoints(flow):
    """Every ACTIVE endpoint for a direction, not just the default one.

    The default device is usually the only one, but a headset that presents its
    own endpoint would put the meeting's session on a device the default lookup
    never reads - and the symptom of that is a meeting that is never detected,
    with nothing anywhere saying why.
    """
    devices = []
    enumerator = None
    collection = None
    try:
        enumerator = AudioUtilities.GetDeviceEnumerator()
        collection = enumerator.EnumAudioEndpoints(flow.value, DEVICE_STATE.ACTIVE.value)
        for i in range(collection.GetCount()):
            devices.append(collection.Item(i))
    except Exception:
        # Fall back to the default endpoint rather than seeing nothing at all.
        try:
            if enumerator is None:
                enumerator = AudioUtilities.GetDeviceEnumerator()
            devices.append(enumerator.GetDefaultAudioEndpoint(flow.value, ERole.eCommunications.value))
        except Exception:
            devices = []
    finally:
        # Released HERE, on the thread that created them, rather than whenever
        # the collector next runs. See the note on _sessions below.
        collection = None
        enumerator = None
    return devices


def _sessions(flow):
    """(pid, state) for every audio session on every active endpoint.

    EVERY COM POINTER IS RELEASED EXPLICITLY, and that is not tidiness.

    Python does not decide when a COM pointer is released — the garbage
    collector does. A pointer that ends up in a reference CYCLE is not freed by
    refcounting at all; it waits for the cycle collector, and gen-2 is first
    swept about a minute in. Measured on this machine, twice: the agent ran
    cleanly for exactly 60 seconds and then died inside
    `_compointer_base.__del__` with an access violation at a different address
    each time.

    Tracebacks are how these pointers got into cycles. Enumerating audio
    sessions raises routinely — the system-sounds session (pid 0) has no
    process id — and a raised exception captures the frame, and the frame holds
    every COM local in scope. Setting them to None in a `finally` empties the
    frame at a known point on the owning thread, so a lingering traceback holds
    nothing that still needs releasing.

    The apartment is the other half of the fix and lives in __init__.py.
    """
    out = []
    seen = set()
    devices = _endpoints(flow)
    try:
        for device in devices:
            mgr = None
            sessions = None
            try:
                # QueryInterface rather than ctypes.cast: it is the documented
                # way to obtain a second, independently-owned pointer, and it
                # keeps this file free of raw pointer casts.
                mgr = device.Activate(
                    IAudioSessionManager2._iid_, CLSCTX_ALL, None,
                ).QueryInterface(IAudioSessionManager2)
                sessions = mgr.GetSessionEnumerator()
                count = sessions.GetCount()
            except Exception:
                # A missing or disabled endpoint is a real state on a laptop
                # with no microphone, not a crash.
                count = 0
            try:
                for i in range(count):
                    ctl = None
                    ctl2 = None
                    try:
                        ctl = sessions.GetSession(i)
                        ctl2 = ctl.QueryInterface(IAudioSessionControl2)
                        pid = ctl2.GetProcessId()
                        state = ctl.GetState()
                    except Exception:
                        continue
                    finally:
                        ctl2 = None
                        ctl = None
                    key = (pid, state)
                    if key in seen:
                        continue
                    seen.add(key)
                    out.append((pid, state))
            finally:
                sessions = None
                mgr = None
    finally:
        # The list is the last thing holding the device pointers.
        del devices[:]
    return out


def snapshot():
    """What is using audio right now, with names - the diagnostic view."""
    rows = []
    for flow, label in ((EDataFlow.eRender, "render"), (EDataFlow.eCapture, "capture")):
        for pid, state in _sessions(flow):
            name = process_name(pid)
            rows.append({
                "endpoint": label,
                "pid": pid,
                "state": state,
                "active": state == STATE_ACTIVE,
                "process": name,
                "known": name in config.MEETING_PROCESSES,
                "denied": name in NOT_A_MEETING or pid == os.getpid(),
            })
    return rows


def detect_meeting():
    """The meeting currently in progress, or None.

    Returns the process holding the microphone, its name and its window title,
    so the caller can label the meeting without asking anyone.
    """
    capture = [(pid, st) for pid, st in _sessions(EDataFlow.eCapture) if st == STATE_ACTIVE]
    if not capture:
        return None

    render_active = {pid for pid, st in _sessions(EDataFlow.eRender) if st == STATE_ACTIVE}
    own = os.getpid()

    candidates = []
    for pid, _state in capture:
        if pid == own or pid == 0:
            continue
        name = process_name(pid)
        if not name or name in NOT_A_MEETING:
            continue
        candidates.append({
            "pid": pid,
            "process": name,
            "title": window_title(pid) or None,
            "known": name in config.MEETING_PROCESSES,
            # Not a requirement - a participant listening on a headset the agent
            # cannot see is still in a meeting - but worth recording, because it
            # is the difference between a call and an app that opened the mic.
            "also_playing": pid in render_active,
        })

    if not candidates:
        return None
    # A recognised meeting app wins over an unknown one; among equals, the one
    # that is also playing audio is more likely to be the call.
    candidates.sort(key=lambda c: (c["known"], c["also_playing"]), reverse=True)
    return candidates[0]
