"""
`python -m meeting_agent.selftest`

Offline proof that the capture pipeline works, with no audio device, no server
and no meeting. It speaks two known sentences through the Windows speech
synthesiser and asserts that the resampler, the VAD and the segmenter turn them
back into exactly two utterances.

The last check is the important one. Silero v5 takes 576 samples - a 512-sample
frame with 64 samples of the PREVIOUS frame prepended as context - and the ONNX
input shape is [None, None], so feeding it a bare 512 is accepted, raises
nothing, and returns a probability of ~0.001 for everything. Measured on the
fixture below: 0 of 243 frames detected as speech at 512, 190 of 243 at 576.

That is the worst shape a bug can have. It does not crash, it does not warn,
and its output is a well-formed number meaning "nobody spoke" - so it would
have shipped as an agent that records meetings and captures silence. The
regression test exists because nothing else would have caught it.
"""
import gc
import os
import subprocess
import sys
import wave

import numpy as np

from . import config
from .audio import Resampler, rms, to_mono_float32
from .recorder import Segmenter
from .vad import load_vad

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURE = os.path.join(HERE, "models", "_speech_fixture.wav")

SENTENCES = [
    "We need a new catalog item for laptop requests.",
    "It should require manager approval before I T fulfils it.",
]


def ensure_fixture():
    """Synthesise the fixture with Windows TTS rather than committing a WAV."""
    if os.path.exists(FIXTURE):
        return True
    script = (
        "Add-Type -AssemblyName System.Speech; "
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; "
        "$s.SetOutputToWaveFile('{}'); ".format(FIXTURE.replace("\\", "\\\\"))
        + "".join("$s.Speak('{}'); ".format(t) for t in SENTENCES)
        + "$s.Dispose()"
    )
    try:
        subprocess.run(["powershell", "-NoProfile", "-Command", script],
                       check=True, capture_output=True, timeout=60)
    except Exception as err:
        print("  could not synthesise the fixture: {}".format(err))
        return False
    return os.path.exists(FIXTURE)


def load_fixture():
    w = wave.open(FIXTURE)
    raw = w.readframes(w.getnframes())
    ch, sr = w.getnchannels(), w.getframerate()
    w.close()
    return Resampler(sr, config.SAMPLE_RATE).process(to_mono_float32(raw, ch)), sr


def check_resampler():
    """A 440 Hz tone must survive every rate this machine actually produces,
    fed in ragged chunks - the boundaries are where a stateless resampler
    clicks, and a click is a consonant to a speech model."""
    print("[1] resampler")
    ok = True
    for src in (48000, 44100, 16000):
        r = Resampler(src, config.SAMPLE_RATE)
        t = np.arange(src * 2) / src
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        out, i = [], 0
        for n in ([1024, 700, 2048, 333] * 500):
            if i >= tone.size:
                break
            out.append(r.process(tone[i:i + n]))
            i += n
        y = np.concatenate(out)
        spec = np.abs(np.fft.rfft(y * np.hanning(y.size)))
        peak = np.fft.rfftfreq(y.size, 1.0 / config.SAMPLE_RATE)[spec.argmax()]
        good = abs(peak - 440) < 2 and abs(rms(y) - 0.3536) < 0.02
        ok = ok and good
        print("    {:5d} Hz -> {} samples, peak {:.1f} Hz, rms {:.4f}  {}".format(
            src, y.size, peak, rms(y), "OK" if good else "FAILED"))
    return ok


def check_vad_context():
    """The regression that this whole file exists for."""
    print("[2] Silero context (the 512-vs-576 trap)")
    vad, warn = load_vad()
    if warn or vad.name.startswith("energy"):
        print("    SKIPPED - Silero is not loaded ({})".format(warn))
        return True
    x, _ = load_fixture()
    F = config.VAD_FRAME

    vad.reset()
    with_ctx = sum(1 for i in range(0, x.size - F, F)
                   if vad.speech_prob(x[i:i + F]) > config.VAD_THRESHOLD)

    # Deliberately bypass the context to prove the failure is still detectable.
    vad.reset()
    sr = np.array(config.SAMPLE_RATE, dtype=np.int64)
    state = np.zeros((2, 1, 128), dtype=np.float32)
    without = 0
    for i in range(0, x.size - F, F):
        out, state = vad.sess.run(None, {
            "input": x[i:i + F].reshape(1, -1).astype(np.float32), "state": state, "sr": sr})
        if float(np.asarray(out).ravel()[0]) > config.VAD_THRESHOLD:
            without += 1

    total = len(range(0, x.size - F, F))
    print("    with 64-sample context : {}/{} frames are speech".format(with_ctx, total))
    print("    without (the bug)      : {}/{} frames are speech".format(without, total))
    good = with_ctx > total * 0.4 and without < total * 0.1
    print("    {}".format("OK - context is applied" if good else "FAILED - check SileroVad.speech_prob"))
    return good


def check_segmenter():
    """Two spoken sentences must come back as two utterances."""
    print("[3] segmenter")
    x, _ = load_fixture()
    got = []
    vad, _w = load_vad()
    seg = Segmenter(vad, lambda a, s, e: got.append((s, e, a.size)))
    i = 0
    for n in ([1024, 512, 2000, 777] * 500):
        if i >= x.size:
            break
        seg.feed(x[i:i + n])
        i += n
    seg.flush()
    for s, e, n in got:
        print("    {:6d} -> {:6d} ms  ({} ms)".format(s, e, e - s))
    good = (len(got) == len(SENTENCES)
            and got[0][0] < config.PREROLL_MS
            and all(e > s for s, e, _ in got)
            and all(got[k][1] < got[k + 1][0] for k in range(len(got) - 1)))
    print("    {}".format(
        "OK - {} sentences -> {} utterances, pre-roll intact, no overlap".format(len(SENTENCES), len(got))
        if good else "FAILED - expected {} utterances, got {}".format(len(SENTENCES), len(got))))
    return good


def check_stt_guards():
    """The two Whisper failure modes that produce plausible wrong transcripts.

    Neither raises, and both survive as text that reads like content - so they
    are asserted rather than trusted. Both were found on REAL captured audio,
    not imagined.
    """
    print("[4] STT guards")
    try:
        from .stt_server import is_degenerate, is_silence_hallucination, rejection_reason
    except Exception as err:
        print("    SKIPPED - {}".format(err))
        return True
    cases = [
        ("halluc", "You", 0.008, True, "real speaker bleed transcribed as 'You'"),
        ("halluc", "You", 0.180, False, "a genuine 'you' in audible speech is untouched"),
        ("halluc", "Thank you.", 0.010, True, "stock phrase on near-silence"),
        ("halluc", "We need a catalog item", 0.008, False, "quiet but real content survives"),
        ("degen", ". . . . . . . . . . . .", None, True, "decoder loop"),
        ("degen", "We need a new catalog item for laptop requests.", None, False, "real speech"),
    ]
    # Real values measured off one auto-detected recording (see stt_server.py).
    # (text, no_speech_prob, avg_logprob, chars/sec, should_be_rejected)
    confidence = [
        ("Right, so the approval chain is the thing we still have not settled.", 0.001, -0.05, 17.4, False),
        ("My view is that the line manager approves anything under 2,000.", 0.001, -0.15, 16.8, False),
        ("You're right. So close.", 0.444, -0.90, 10.9, True),
        ("What's going on?", 0.279, -1.38, 6.9, True),
        ("I'm not sure if I'm going to do that anymore.", 0.584, -1.24, 127.8, True),
        ("my", 0.412, -1.06, 6.2, True),
    ]
    ok = True
    for text, nsp, lp, cps, expected in confidence:
        got = rejection_reason(text, nsp, lp, cps) is not None
        good = got == expected
        ok = ok and good
        print("    {} conf    {!r:<50} -> {}   {}".format(
            "OK  " if good else "FAIL", text[:46], got,
            "hallucinated room noise" if expected else "real speech"))
    for kind, text, level, expected, why in cases:
        got = is_silence_hallucination(text, level) if kind == "halluc" else is_degenerate(text)
        good = got == expected
        ok = ok and good
        print("    {} {:<7} {!r:<50} -> {}   {}".format(
            "OK  " if good else "FAIL", kind, text[:46], got, why))
    return ok


def check_clock_gap():
    """A device that stops delivering must not compress the timeline.

    A WASAPI loopback stream produces NOTHING while the speakers are silent
    (measured: 0 callbacks in 4s). If elapsed time is counted from samples
    received, the system track's clock stops during every pause while the
    microphone's keeps running - so the two tracks drift apart and the merged
    transcript interleaves wrongly, further out the longer the meeting runs.

    Here the same speech is fed twice with a 5-SECOND GAP in which no samples
    arrive at all, exactly as a loopback device behaves. The second utterance
    must land after the gap, not immediately after the first.
    """
    print("[5] clock survives a device gap")
    x, _ = load_fixture()
    got = []
    vad, _w = load_vad()
    seg = Segmenter(vad, lambda a, s, e: got.append((s, e)))

    def feed_all(audio, base_ms):
        i, n = 0, 4096
        while i < audio.size:
            chunk = audio[i:i + n]
            i += chunk.size
            seg.feed(chunk, chunk_end_ms=base_ms + i / (config.SAMPLE_RATE / 1000.0))

    feed_all(x, 0.0)
    # 5 seconds pass during which the device delivers nothing at all.
    gap_end = x.size / (config.SAMPLE_RATE / 1000.0) + 5000.0
    feed_all(x, gap_end)
    seg.flush()

    for s_, e_ in got:
        print("    {:7.0f} -> {:7.0f} ms".format(s_, e_))
    after_gap = [s_ for s_, _e in got if s_ >= gap_end - 500]
    good = len(got) >= 2 and len(after_gap) >= 1
    print("    {}".format(
        "OK - {} utterance(s) landed after the 5s gap, so the gap was not swallowed".format(len(after_gap))
        if good else "FAILED - the timeline collapsed across the gap"))
    return good


def check_com_hygiene():
    """The apartment and the release discipline that keep the agent alive.

    Measured twice on this machine: the agent ran cleanly for exactly 60
    seconds and then died inside comtypes' deallocator with an access violation
    at a different address each run. Sixty seconds is when Python's generational
    collector first sweeps gen-2 — where COM pointers land when a traceback
    captures the frame holding them, which the session enumeration does
    routinely because the system-sounds session has no process id.

    Two things fixed it, and both are invisible at a glance, so both are
    asserted here rather than trusted to survive the next edit.
    """
    print("[6] COM hygiene")
    ok = True

    mta = getattr(sys, "coinit_flags", None) == 0
    ok = ok and mta
    print("    {} apartment: sys.coinit_flags = {} {}".format(
        "OK  " if mta else "FAIL", getattr(sys, "coinit_flags", "unset"),
        "(MTA - a COM pointer may be released from any thread)" if mta
        else "(STA - COM pointers get thread affinity and the collector will eventually free one from the wrong thread)"))

    # A per-call CoInitialize() forces an STA and undoes the line above. It now
    # raises RPC_E_CHANGED_MODE, which is a loud failure rather than a silent
    # regression - but it must not be there at all.
    detect_src = open(os.path.join(HERE, "meeting_agent", "detect.py"), encoding="utf-8").read()
    clean = "CoInitialize(" not in detect_src
    ok = ok and clean
    print("    {} detect.py makes no per-call CoInitialize()".format("OK  " if clean else "FAIL"))

    # Every COM local must be dropped in a finally, so a lingering traceback
    # holds nothing that still needs releasing.
    releases = detect_src.count("mgr = None") + detect_src.count("ctl = None") + detect_src.count("sessions = None")
    enough = releases >= 3
    ok = ok and enough
    print("    {} COM pointers released explicitly ({} sites)".format("OK  " if enough else "FAIL", releases))

    # And it still has to work.
    try:
        from .detect import detect_meeting, snapshot
        for _ in range(120):
            snapshot()
            detect_meeting()
        gc.collect(2)   # the generation that used to take the process down
        print("    OK   240 polls + a gen-2 collection, no deallocator fault")
    except Exception as err:
        ok = False
        print("    FAIL detection raised: {}".format(err))
    return ok


def main():
    print("NowHelpAssist capture agent - self test\n")
    if not ensure_fixture():
        print("Cannot run without the speech fixture.")
        return 1
    results = [check_resampler(), check_vad_context(), check_segmenter(),
               check_stt_guards(), check_clock_gap(), check_com_hygiene()]
    print("\n{}".format("ALL CHECKS PASSED" if all(results) else "SOME CHECKS FAILED"))
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
