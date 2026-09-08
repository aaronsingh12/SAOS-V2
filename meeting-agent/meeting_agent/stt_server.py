"""
`python -m meeting_agent.stt_server`  -  the transcription sidecar ("meetingd").

DELIBERATELY DUMB. It loads models and turns one WAV into text. It owns no
queue, no priorities, no backpressure policy and no knowledge of meetings. All
of that lives in the Node server, for two reasons:

  1. Node owns the database and the meeting lifecycle, so there is one source
     of truth about what has been transcribed and what has not.
  2. Swapping local Whisper for a hosted STT API then means rewriting ONE file
     in Node (`meetings/stt.js`) and nothing here - which is the "make the STT
     service replaceable" requirement, enforced structurally rather than
     promised.

It is a separate PROCESS rather than a library because the NHA server has two
dependencies (express, cors) and node:sqlite, and it stays that way. PyTorch-
free, but ctranslate2 is still 40 MB of native code that has no business inside
a Node process.

Served on loopback only, with stdlib http.server - no flask, no fastapi.

MEASURED on this machine (8 cores, no GPU, int8, cpu_threads=6):

    model      RTF     fixed cost per call    domain words
    tiny.en    25.5x   0.39s                  "Full filament" for "fulfilment"
    base.en    12.6x   0.75s                  correct
    small.en    3.8x   2.87s                  correct, no gain over base.en

The fixed cost is the number that matters and it is not obvious: Whisper pads
every input to a 30-SECOND WINDOW, so a 3.7s utterance and a 15.6s utterance
cost almost the same (small.en: 2.87s vs 3.49s). Short utterances are therefore
disproportionately expensive, and RTF measured on long files badly overstates
what a VAD-chunked meeting will achieve.
"""
import json
import os
import threading
import time
import wave
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import numpy as np

HOST = os.environ.get("NHA_STT_HOST", "127.0.0.1")
PORT = int(os.environ.get("NHA_STT_PORT", "4600"))
THREADS = int(os.environ.get("NHA_STT_THREADS", str(max(1, (os.cpu_count() or 4) - 2))))

# The live model is the biggest one that keeps up with headroom on THIS CPU.
# See the table above: small.en is 2.5x the cost of base.en for no measurable
# quality gain on the benchmark, and tiny.en makes real word errors.
DEFAULT_MODEL = os.environ.get("NHA_STT_MODEL", "base.en")

# Fed to Whisper as `initial_prompt`. It costs nothing at inference (prefix
# tokens only) and measurably fixes domain vocabulary: without it the benchmark
# produced "cost center" for "cost centre" on every model.
VOCAB_PROMPT = (
    "ServiceNow, catalog item, sys_user, RITM, SLA, UI policy, fulfilment, "
    "cost centre, scoped application, incident, approval, flow designer."
)

# MEASURED, and the reason `use_prompt` exists below.
#
# The vocabulary prompt is free on real speech (3.04s clip: 0.66s -> 0.74s) and
# fixes domain words. On NEAR-SILENT audio it is a disaster: the model tries to
# continue the prompt, generates garbage, fails Whisper's compression-ratio
# check, and re-runs the ENTIRE temperature fallback ladder.
#
#   0.38s clip at rms 0.014, base.en:
#     no prompt                0.61s   ""
#     with vocab prompt       11.39s   ""            <- 18x, for nothing
#     with prompt, temp=0      1.98s   ". . . . . ."  <- degenerate output
#
# A live meeting is full of these: every quiet moment of speaker bleed becomes
# an 11-second stall, and the backlog never recovers. So the prompt is applied
# only to audio long enough and loud enough to be real speech - which is
# exactly where it was measured to help.
PROMPT_MIN_DURATION_S = 1.0
PROMPT_MIN_RMS = 0.02

# WHISPER'S OWN CONFIDENCE SIGNALS, which the first version ignored entirely.
#
# A microphone in a quiet room still picks up a fan, a keyboard and breathing.
# Silero calls that speech (it is sound in the speech band), Whisper is then
# handed 0.35s of room noise, and it INVENTS A SENTENCE. Measured on one real
# auto-detected recording, mic track:
#
#   0.35s of hum -> "I'm not sure if I'm going to do that anymore."   (128 ch/s)
#   1.34s of hum -> "and all the long long long long long long..."     (46 ch/s)
#   2.30s of hum -> "What's going on?"
#
# Those are fabricated sentences that read exactly like meeting content, and in
# phase 4 they would become extracted requirements. Nothing about the text
# itself gives them away.
#
# The signals do, and the separation is not marginal. Same recording:
#
#             no_speech_prob   avg_logprob   chars/sec
#   real speech    0.000       -0.15..-0.35    16-17
#   hallucinated   0.21..0.58  -0.95..-1.56    6..128
#
# avg_logprob alone separates all ten clips with a wide margin either side.
# All three are checked, because they fail independently.
NO_SPEECH_MAX = 0.5
LOGPROB_MIN = -0.8
# Fast human speech tops out around 15 characters per second. Anything far
# above that is text the model produced without audio to justify it.
MAX_CHARS_PER_SEC = 25.0

_models = {}
_models_lock = threading.Lock()
# CPU-bound work is serialised. Two concurrent transcriptions on the same cores
# finish no sooner together and make every latency number unpredictable.
_infer_lock = threading.Lock()

_stats = {"calls": 0, "audio_s": 0.0, "wall_s": 0.0, "errors": 0}


def get_model(name):
    with _models_lock:
        if name in _models:
            return _models[name], 0.0
    from faster_whisper import WhisperModel
    t0 = time.monotonic()
    m = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=THREADS)
    load = time.monotonic() - t0
    with _models_lock:
        _models[name] = m
    return m, load


def read_wav_16k(path):
    """Utterances are written by this project's own capture agent, so they are
    always 16 kHz mono 16-bit. Anything else is a bug worth failing on rather
    than silently resampling and producing a plausible wrong transcript."""
    with wave.open(path, "rb") as w:
        if w.getnchannels() != 1 or w.getframerate() != 16000 or w.getsampwidth() != 2:
            raise ValueError(
                "expected 16 kHz mono 16-bit, got {} Hz {} ch {}-bit".format(
                    w.getframerate(), w.getnchannels(), w.getsampwidth() * 8))
        n = w.getnframes()
        raw = w.readframes(n)
    return np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0, n / 16000.0


# MEASURED on real captured speaker bleed.
#
# Two mic utterances at rms 0.008 and 0.011 (the meeting audio leaking from the
# speakers back into the microphone) both transcribed as the single word "You".
# That is a well-documented Whisper behaviour on near-silence: with nothing to
# transcribe it emits a short high-frequency stock phrase.
#
# Left alone it is worse than an empty transcript, because it is attributed to a
# TRACK - so "You" appears in the transcript as something the user said, and the
# understanding pass in phase 4 would treat it as content.
#
# The gate is deliberately narrow: only audio BELOW the speech floor, and only a
# handful of words. Real speech that quiet is inaudible anyway, and a genuine
# "you" in an audible utterance is untouched.
SILENCE_HALLUCINATIONS = {
    "you", "thank you", "thanks", "thank you.", "thanks for watching",
    "thanks for watching!", "bye", "bye.", "so", "um", "uh", "okay", "ok",
    "the", "yeah", "hmm", "mm", "mhm", "please subscribe", "you're welcome",
    "[blank_audio]", "[silence]",
}
HALLUCINATION_MAX_WORDS = 3


def is_silence_hallucination(text, level):
    if level >= PROMPT_MIN_RMS:
        return False
    t = (text or "").strip().lower().strip(".,!?-— ")
    if not t:
        return False
    if len(t.split()) > HALLUCINATION_MAX_WORDS:
        return False
    return t in SILENCE_HALLUCINATIONS


def rejection_reason(text, no_speech, logprob, chars_per_sec):
    """Why this transcript should be thrown away, or None to keep it.

    Pure, so the self-test can assert the thresholds against the real measured
    values without loading a model. See the constants above for the evidence.
    """
    if not text:
        return None
    if no_speech > NO_SPEECH_MAX:
        return "no_speech_prob {:.2f} > {:.2f}".format(no_speech, NO_SPEECH_MAX)
    if logprob < LOGPROB_MIN:
        return "avg_logprob {:.2f} < {:.2f}".format(logprob, LOGPROB_MIN)
    if chars_per_sec > MAX_CHARS_PER_SEC:
        return "{:.0f} chars/sec is faster than speech".format(chars_per_sec)
    return None


def is_degenerate(text):
    """A transcript that is one token repeated is a decoder loop, not speech.

    Measured output from the failure above: ". . . . . . . . . . . .". Next to a
    real transcript that reads as content, so it is detected and blanked rather
    than stored as something the understanding pass would later try to extract a
    requirement from.
    """
    t = (text or "").strip()
    if len(t) < 8:
        return False
    tokens = t.split()
    if len(tokens) < 6:
        return False
    return len(set(tokens)) <= max(1, len(tokens) // 8)


def transcribe(path, model_name=None, prompt=None, beam_size=1):
    name = model_name or DEFAULT_MODEL
    audio, duration = read_wav_16k(path)
    level = float(np.sqrt(np.mean(np.square(audio, dtype=np.float64)))) if audio.size else 0.0
    # See PROMPT_MIN_* above. `prompt=""` from the caller means "none, deliberately".
    use_prompt = (prompt if prompt is not None else
                  (VOCAB_PROMPT if (duration >= PROMPT_MIN_DURATION_S and level >= PROMPT_MIN_RMS) else ""))
    model, load_s = get_model(name)
    t0 = time.monotonic()
    with _infer_lock:
        segments, info = model.transcribe(
            audio,
            beam_size=beam_size,
            language="en",
            initial_prompt=use_prompt or None,
            # The capture agent already ran Silero over this audio to decide it
            # was speech. Running Whisper's own VAD again would sometimes
            # disagree and return nothing for an utterance we know contains
            # words, which reads as silence rather than as a disagreement.
            vad_filter=False,
            condition_on_previous_text=False,
            # THE TEMPERATURE FALLBACK LADDER IS PURE WASTE HERE.
            #
            # By default Whisper re-runs a segment at temperatures
            # [0, 0.2, 0.4, 0.6, 0.8, 1.0] whenever its compression-ratio or
            # logprob check fails - which is exactly the low-confidence output
            # this server DISCARDS a few lines below. So it was paying up to 6x
            # to marginally improve text that is thrown away.
            #
            # MEASURED over one real call plus one noisy recording (9 clips):
            #   6 real-speech clips  identical text, identical time (~0.7s)
            #                        - the ladder never fires on good audio
            #   3 noise clips        5.30s -> 1.85s, 6.14s -> 0.96s, 1.62s -> 0.76s
            #   TOTAL                17.2s -> 7.6s, a 55% saving
            #
            # Nothing a user would keep changed. Everything that got faster was
            # already being discarded.
            temperature=0.0,
        )
        seg_list = list(segments)
        text = " ".join(s.text.strip() for s in seg_list).strip()
    wall = time.monotonic() - t0

    # Worst value across the returned segments: one bad span is enough.
    no_speech = max([getattr(s, "no_speech_prob", 0.0) for s in seg_list], default=1.0)
    logprob = min([getattr(s, "avg_logprob", 0.0) for s in seg_list], default=-9.0)
    cps = (len(text) / duration) if duration > 0 else 0.0

    rejected = rejection_reason(text, no_speech, logprob, cps)
    # The text is still RETURNED when it is not trusted. Node marks it `low` and
    # shows it flagged rather than dropping it, because a real sentence spoken
    # over wind or a third person talking is exactly what fails these checks,
    # and a blank line is indistinguishable from nobody speaking. It can never
    # be cited as evidence, so nothing downstream can be built on it.
    raw_text = text
    if rejected:
        text = ""
    degenerate = is_degenerate(text)
    if degenerate:
        text = ""
    hallucinated = is_silence_hallucination(text, level)
    if hallucinated:
        text = ""
    _stats["calls"] += 1
    _stats["audio_s"] += duration
    _stats["wall_s"] += wall
    return {
        "text": text,
        "degenerate": degenerate,
        "hallucinated": hallucinated,
        "rejected": rejected,
        "rawText": raw_text if rejected else None,
        "no_speech_prob": round(float(no_speech), 3),
        "avg_logprob": round(float(logprob), 2),
        "chars_per_sec": round(cps, 1),
        "rms": round(level, 4),
        "prompted": bool(use_prompt),
        "model": name,
        "duration_s": round(duration, 3),
        "wall_s": round(wall, 3),
        "rtf": round(duration / wall, 2) if wall > 0 else None,
        "load_s": round(load_s, 2) if load_s else 0.0,
        "language_probability": round(getattr(info, "language_probability", 0.0) or 0.0, 3),
    }


def health():
    avg = (_stats["audio_s"] / _stats["wall_s"]) if _stats["wall_s"] > 0 else None
    return {
        "ok": True,
        "device": "cpu",
        "cpu_threads": THREADS,
        "default_model": DEFAULT_MODEL,
        "loaded": sorted(_models.keys()),
        "vocab_prompt": VOCAB_PROMPT,
        # The honest performance number: what this machine has ACTUALLY
        # achieved, not what a model is supposed to do. Node uses it to decide
        # whether to downgrade, and the page shows it.
        "measured_rtf": round(avg, 2) if avg else None,
        "calls": _stats["calls"],
        "errors": _stats["errors"],
    }


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _send(self, code, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.startswith("/health"):
            return self._send(200, health())
        self._send(404, {"error": "not found"})

    def do_POST(self):
        if not self.path.startswith("/transcribe"):
            return self._send(404, {"error": "not found"})
        try:
            n = int(self.headers.get("Content-Length") or 0)
            req = json.loads(self.rfile.read(n) or b"{}")
        except Exception as err:
            return self._send(400, {"error": "bad request: {}".format(err)})

        path = req.get("path")
        if not path or not os.path.exists(path):
            return self._send(404, {"error": "no such audio file: {}".format(path)})
        try:
            return self._send(200, transcribe(
                path,
                model_name=req.get("model"),
                prompt=req.get("prompt"),
                beam_size=int(req.get("beam_size") or 1),
            ))
        except Exception as err:
            _stats["errors"] += 1
            # Reported, never swallowed: an utterance that failed must not look
            # like an utterance that was silent.
            return self._send(500, {"error": "{}: {}".format(type(err).__name__, err)})

    def log_message(self, fmt, *args):
        pass  # the useful lines are printed by main(), not per request


def main():
    print("NowHelpAssist STT sidecar")
    print("  http://{}:{}   model {}   {} cpu threads".format(HOST, PORT, DEFAULT_MODEL, THREADS))
    print("  loading {} (first load takes ~20s, and downloads it once)...".format(DEFAULT_MODEL), flush=True)
    try:
        _, load = get_model(DEFAULT_MODEL)
        print("  ready in {:.1f}s".format(load), flush=True)
    except Exception as err:
        print("  FAILED to load {}: {}".format(DEFAULT_MODEL, err))
        print("  the server will start anyway and report this on /health")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
