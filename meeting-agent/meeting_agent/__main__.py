"""
`python -m meeting_agent`

The supervisor: watch for a meeting, record it, stop when it ends, repeat.
Nobody presses anything.

Two deliberate properties:

  RECORDING IS VISIBLE. Every start and stop prints a line, and the heartbeat
  tells the server so the Meetings page can show it. A tool that records
  meetings must never be ambiguous about whether it is recording.

  A FAILURE ENDS THE MEETING, NOT THE AGENT. If the server goes away mid-call
  the current meeting is closed and the loop keeps watching, because the next
  meeting is a fresh chance to work. Utterances already written stay on disk
  and are still posted when the server returns.
"""
import argparse
import signal
import sys
import time
from datetime import datetime, timezone

from . import __version__, config
from .client import Client, ServerError
from .detect import detect_meeting, snapshot
from .recorder import MeetingRecorder
from .vad import load_vad

_stop = False


def _log(msg):
    print("{}  {}".format(datetime.now().strftime("%H:%M:%S"), msg), flush=True)


def _handle_signal(_sig, _frame):
    global _stop
    _stop = True
    _log("stopping - finishing the current meeting first")


def record_once(client, seconds):
    """Record for a fixed time with no detection at all.

    The point of phase 1 is to find out whether the captured audio is clean and
    the two tracks are the right way round, and waiting for a real meeting to
    find that out is a slow feedback loop. This records whatever the speakers
    and the microphone are doing right now, so a song and a sentence are enough
    to check the whole path.

    Marked `detected_by: manual`, so a test recording is never mistaken for a
    meeting the detector found.
    """
    opened = client.start_meeting(
        title="Manual test recording ({}s)".format(seconds),
        source_app=None, source_pid=0, detected_by="manual",
        agent_version=__version__,
        started_at=datetime.now(timezone.utc).isoformat(),
    )
    rec = MeetingRecorder(opened["id"], opened["audioDir"], client, _log)
    tracks = rec.start()
    _log("RECORDING for {}s - tracks: {}".format(seconds, ", ".join(tracks)))
    _log("say something, and play something through the speakers")
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline and not _stop:
        time.sleep(0.2)
    counts, dropped = rec.stop()
    client.end_meeting(opened["id"])
    _log("STOPPED - {} utterances from you, {} from them{}".format(
        counts.get("mic", 0), counts.get("system", 0),
        ", {} DROPPED".format(dropped) if dropped else ""))
    _log("review and PLAY THEM BACK at http://localhost:5173/meetings")
    return 0


def main():
    # Declared up here rather than beside the assignment: a `global` statement
    # must precede every use of the name in its scope, and the watch loop below
    # reads `_stop` long before the heartbeat sets it.
    global _stop

    parser = argparse.ArgumentParser(prog="meeting_agent", description="NowHelpAssist capture agent")
    parser.add_argument("--record", type=int, metavar="SECONDS",
                        help="record immediately for N seconds instead of watching for a meeting")
    args = parser.parse_args()

    signal.signal(signal.SIGINT, _handle_signal)
    signal.signal(signal.SIGTERM, _handle_signal)

    client = Client()
    if args.record:
        vad, warn = load_vad()
        if warn:
            _log("WARNING: {}".format(warn))
        _log("capture agent v{} - manual recording, VAD {}".format(__version__, vad.name))
        try:
            return record_once(client, args.record)
        except (ServerError, RuntimeError) as err:
            _log("recording failed: {}".format(err))
            return 1

    vad, warn = load_vad()
    if warn:
        _log("WARNING: {}".format(warn))

    _log("NowHelpAssist capture agent v{} - watching for meetings".format(__version__))
    _log("server {}  |  VAD {}  |  stop after {:.0f}s of silence".format(
        config.SERVER, vad.name, config.STOP_AFTER_S))

    recorder = None
    meeting = None
    gone_since = None
    last_beat = 0.0
    last_report = 0.0
    last_seen_sig = None

    while not _stop:
        try:
            found = detect_meeting()
        except Exception as err:
            _log("detection failed: {}".format(err))
            found = None

        now = time.monotonic()

        """
        SAY WHAT IS BEING SEEN.

        The first version printed one line at startup and then nothing at all.
        A real call went undetected for two minutes and the terminal was
        identical to a terminal where everything was working - so there was no
        way to tell "no meeting yet" from "broken". Silence is not a status.

        Any change in what is holding the microphone is reported, and there is
        a heartbeat line every 60s so the agent is visibly alive.
        """
        if not recorder:
            try:
                mics = [r for r in snapshot() if r["endpoint"] == "capture" and r["active"]]
            except Exception:
                mics = []
            sig = tuple(sorted((r["pid"], r["process"]) for r in mics))
            if sig != last_seen_sig:
                last_seen_sig = sig
                if mics:
                    _log("microphone in use by: " + ", ".join(
                        "{} (pid {}){}".format(r["process"] or "?", r["pid"],
                                               "" if not r["denied"] else " [ignored]")
                        for r in mics))
                else:
                    _log("microphone is idle - nothing to record")
                last_report = now
            elif now - last_report >= 60:
                last_report = now
                _log("still watching - microphone {}".format(
                    "in use by " + ", ".join(r["process"] or "?" for r in mics) if mics else "idle"))

        # --- start ---------------------------------------------------------
        if found and not recorder:
            try:
                opened = client.start_meeting(
                    title=found["title"],
                    source_app=found["process"],
                    source_pid=found["pid"],
                    detected_by="auto",
                    agent_version=__version__,
                    started_at=datetime.now(timezone.utc).isoformat(),
                )
                meeting = opened
                recorder = MeetingRecorder(opened["id"], opened["audioDir"], client, _log)
                tracks = recorder.start()
                _log("RECORDING {!r} - {} (pid {}){} - tracks: {}".format(
                    found["title"] or "untitled", found["process"], found["pid"],
                    "" if found["known"] else " [not a known meeting app - recording anyway]",
                    ", ".join(tracks)))
            except (ServerError, RuntimeError) as err:
                _log("could not start recording: {}".format(err))
                recorder, meeting = None, None
                time.sleep(5)
                continue
            gone_since = None

        # --- stop ----------------------------------------------------------
        if recorder:
            if found:
                gone_since = None
            else:
                gone_since = gone_since or now
                if now - gone_since >= config.STOP_AFTER_S:
                    _log("meeting signal gone for {:.0f}s - stopping".format(config.STOP_AFTER_S))
                    counts, dropped = recorder.stop()
                    try:
                        client.end_meeting(meeting["id"])
                    except ServerError as err:
                        _log("the meeting was recorded but could not be closed on the server: {}".format(err))
                    _log("STOPPED - {} utterances from you, {} from them{}".format(
                        counts.get("mic", 0), counts.get("system", 0),
                        ", {} DROPPED".format(dropped) if dropped else ""))
                    _log("review it at http://localhost:5173/meetings")
                    recorder, meeting, gone_since = None, None, None

        # --- heartbeat -----------------------------------------------------
        if now - last_beat >= config.HEARTBEAT_S:
            last_beat = now
            try:
                beat = client.heartbeat(
                    version=__version__,
                    vad=vad.name,
                    detecting=True,
                    active_meeting=meeting["id"] if meeting else None,
                    devices={"mic": "default", "system": "wasapi loopback"},
                )
                """
                THE STOP BUTTON, arriving the only way it safely can.

                The server can now start this agent, so it needs a way to stop
                it - and on Windows there is no SIGTERM. Node's kill() is
                TerminateProcess, a hard kill, which would cut off a recording
                mid-write and leave the meeting open on the server. A stop
                implemented with signals would do exactly that while looking
                graceful in the code.

                So the server ASKS, here, on a round trip this loop was making
                anyway. Setting the same flag the Ctrl-C handler sets means one
                shutdown path, not two: the loop exits, the current meeting is
                closed properly below, and the audio already on disk is intact.

                Worst case is a five-second delay before the agent notices,
                which is the right trade against a truncated recording.
                """
                if isinstance(beat, dict) and beat.get("stop"):
                    _stop = True
                    _log("stop requested by the server - finishing the current meeting first")
            except ServerError:
                # The server being down is not fatal to capture - audio still
                # lands on disk. It is reported once per minute, not per beat.
                if int(now) % 60 < config.HEARTBEAT_S:
                    _log("server unreachable; still capturing to disk")

        time.sleep(config.DETECT_POLL_S)

    if recorder:
        counts, dropped = recorder.stop()
        try:
            client.end_meeting(meeting["id"])
        except ServerError:
            pass
        _log("final meeting closed - {} yours, {} theirs".format(
            counts.get("mic", 0), counts.get("system", 0)))
    _log("agent stopped")
    return 0


if __name__ == "__main__":
    sys.exit(main())
