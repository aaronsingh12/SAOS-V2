"""
`python -m meeting_agent.diagnose`

Run this BEFORE trusting the agent with a real meeting. It answers the four
questions that decide whether phase 1 works on a given machine, and it answers
them from the machine rather than from documentation:

  1. Which two devices will be recorded, and at what rates?
  2. Is the Silero VAD model present, or is the degraded energy gate active?
  3. What audio sessions exist right now, and would any be seen as a meeting?
  4. Can the NowHelpAssist server be reached?

Detection is the part most likely to disappoint quietly on someone else's
machine - a Teams build with a different process name, a headset that presents
its own endpoint - so it is made visible here instead of being discovered as an
empty Meetings page after an hour-long call.
"""
import sys
import time

from . import config
from .client import Client, ServerError
from .detect import NOT_A_MEETING, detect_meeting, snapshot
from .vad import MODEL_PATH, load_vad


def watch():
    """`--watch` - the answer to "why did it not record my meeting?"

    Run this, join the call, and read the screen. It prints every change in what
    is holding the microphone and what the detector concluded, so a miss takes
    seconds to diagnose instead of being guessed at from an empty page later.
    """
    print("Watching audio sessions. Join your meeting now; Ctrl+C to stop.")
    print("The signal is a process holding an ACTIVE session on the CAPTURE endpoint.")
    print("")
    last = None
    try:
        while True:
            rows = snapshot()
            cap = [r for r in rows if r["endpoint"] == "capture" and r["active"]]
            ren = [r for r in rows if r["endpoint"] == "render" and r["active"]]
            m = detect_meeting()
            sig = (tuple(sorted((r["pid"], r["process"]) for r in cap)),
                   tuple(sorted((r["pid"], r["process"]) for r in ren)),
                   m["pid"] if m else None)
            if sig != last:
                last = sig
                print("[{}] microphone: {}".format(time.strftime("%H:%M:%S"),
                    ", ".join("{} (pid {}){}".format(r["process"] or "?", r["pid"],
                        " IGNORED - not-a-meeting list" if r["denied"] else "") for r in cap) or "idle"))
                print("           speakers : {}".format(
                    ", ".join("{} (pid {})".format(r["process"] or "?", r["pid"]) for r in ren) or "idle"))
                if m:
                    print("           => WOULD RECORD: {} (pid {}){}  title={!r}".format(
                        m["process"], m["pid"],
                        "" if m["known"] else "  [unknown app - recorded anyway]", m["title"]))
                else:
                    print("           => would NOT record{}".format("" if cap else " (microphone is idle)"))
                print("")
            time.sleep(1.0)
    except KeyboardInterrupt:
        print("stopped")
    return 0


def main():
    if "--watch" in sys.argv:
        return watch()
    print("NowHelpAssist capture agent - diagnostics\n")

    print("[1] Audio devices")
    try:
        import pyaudiowpatch as pyaudio
        pa = pyaudio.PyAudio()
        try:
            lb = pa.get_default_wasapi_loopback()
            print("    system (them) : {!r}".format(lb["name"]))
            print("                    index {}  {} Hz  {} ch".format(
                lb["index"], int(lb["defaultSampleRate"]), lb["maxInputChannels"]))
        except Exception as err:
            print("    system (them) : UNAVAILABLE - {}".format(err))
        try:
            mic = pa.get_default_input_device_info()
            print("    mic (you)     : {!r}".format(mic["name"]))
            print("                    index {}  {} Hz  {} ch".format(
                mic["index"], int(mic["defaultSampleRate"]), mic["maxInputChannels"]))
        except Exception as err:
            print("    mic (you)     : UNAVAILABLE - {}".format(err))
        pa.terminate()
    except Exception as err:
        print("    PyAudioWPatch failed to load: {}".format(err))

    print("\n[2] Voice activity detection")
    vad, warn = load_vad()
    print("    engine: {}".format(vad.name))
    print("    model : {}".format(MODEL_PATH))
    if warn:
        print("    WARNING: {}".format(warn))
    else:
        print("    OK - utterances will be cut on real speech boundaries.")

    print("\n[3] Audio sessions right now")
    rows = snapshot()
    if not rows:
        print("    (none - no process is using audio)")
    for r in rows:
        mark = "ACTIVE" if r["active"] else "idle  "
        known = " <- known meeting app" if r["process"] in config.MEETING_PROCESSES else ""
        print("    {:8} {}  pid {:<8} {}{}".format(
            r["endpoint"], mark, r["pid"], r["process"] or "(system)", known))

    m = detect_meeting()
    print("")
    if m:
        print("    verdict: MEETING DETECTED - {} (pid {}){} - {!r}".format(
            m["process"], m["pid"],
            "" if m["known"] else " [unknown app - would record anyway]",
            m["title"] or "no window title"))
    else:
        print("    verdict: no meeting right now. ANY process holding an ACTIVE session on the")
        print("             CAPTURE endpoint counts, except the not-a-meeting list.")
    print("")
    print("    If a real call was NOT detected, run this and join the call:")
    print("      python -m meeting_agent.diagnose --watch")

    print("\n[4] NowHelpAssist server")
    try:
        out = Client().heartbeat(version="diagnose", detecting=False, vad=vad.name)
        print("    reachable at {}".format(config.SERVER))
        print("    audio root:  {}".format(out.get("audioRoot")))
    except ServerError as err:
        print("    NOT REACHABLE - {}".format(err))
        return 1
    print("\nAll four checks reported. Start the agent with:  python -m meeting_agent")
    return 0


if __name__ == "__main__":
    sys.exit(main())
