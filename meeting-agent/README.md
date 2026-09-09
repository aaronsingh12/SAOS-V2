# NowHelpAssist capture agent — phases 1–2

Listens for meetings, records them as two separate tracks, cuts them into
utterances on real speech boundaries, posts each one to the NowHelpAssist
server, and transcribes them **while the meeting is still going**.

Nobody presses Start. The agent detects the meeting itself.

Two processes:

| | Command | Job |
|---|---|---|
| capture agent | `python -m meeting_agent` | detect, record, segment |
| STT sidecar | `python -m meeting_agent.stt_server` | one WAV in, text out (port 4600) |

They do not talk to each other. Both talk to the NHA server, which owns the
meeting, the database and the transcription queue.

## Setup

```powershell
cd meeting-agent
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
```

Python 3.14 is fine — every dependency has a `cp314` wheel, so nothing compiles
and no Visual Studio toolchain is needed.

## Check it works on this machine, before trusting it with a meeting

```powershell
.\.venv\Scripts\python.exe -m meeting_agent.selftest    # offline: no devices, no server
.\.venv\Scripts\python.exe -m meeting_agent.diagnose    # devices, VAD, sessions, server
```

`selftest` speaks two known sentences through the Windows speech synthesiser and
asserts they come back as two utterances. `diagnose` prints the two devices it
will record, whether the real VAD or the degraded energy gate is active, every
audio session running right now, and whether the server is reachable.

## Run it

### From the app (normal way)

The capture pill sits bottom-right on **every** page of NowHelpAssist. Open it
and press Start on either process; the server spawns them out of `.venv` and
shows their output when something goes wrong. Nothing needs a terminal.

Two things it deliberately will not do:

- **Start a second one.** If an agent is already heartbeating but the server did
  not start it — because you ran it in a terminal — Start is refused with a 409
  rather than putting two recorders on the same microphone and opening duplicate
  meetings. Stop that one with Ctrl-C first.
- **Kill a recording.** Stop is *cooperative*: the server sets a flag, the agent
  reads it on its next heartbeat (≤5 s), finishes the meeting it is recording,
  and exits. Measured end to end at 6.2 s from button to clean exit. A hard kill
  only happens if it has not exited after 20 s, and the log says it was a kill.

### From a terminal (still supported)

```powershell
# terminal 1 - transcription (first run downloads base.en, ~20s to load)
.\.venv\Scripts\python.exe -m meeting_agent.stt_server

# terminal 2 - capture
.\.venv\Scripts\python.exe -m meeting_agent              # watch for meetings
.\.venv\Scripts\python.exe -m meeting_agent --record 20  # record 20s now, no detection
```

An agent started this way heartbeats like any other, so the app shows it as
running and labels it *started elsewhere* — it just cannot be stopped from
there, because the server has no handle on a process it did not spawn.

The sidecar is optional in the sense that nothing is lost without it: audio is
still captured to disk, the page says the sidecar is down, and every utterance
transcribes when it comes back.

`--record` exists so you can check capture quality without waiting for a real
call. Play something through the speakers, say something into the mic, then open
http://localhost:5173/meetings and **play the utterances back**. That is the
phase 1 acceptance test: a waveform looks fine either way, and only listening
tells you the tracks are the right way round and the cuts fall on silence.

## How detection works

The signal is: **a known process holds an ACTIVE session on the CAPTURE
(microphone) endpoint.**

Watching the speakers alone would fire on every song. Spotify, YouTube and
Netflix open the render endpoint and never the microphone — a meeting always
opens both. The render session is read as a corroborating signal but is not
required, because a muted participant is still in a meeting.

**This is not an allow-list.** The first version only recorded processes on a
hardcoded list of meeting apps. It missed a real call and said nothing for two
minutes - no recording, and no explanation. An allow-list has to be complete to
work and never can be: Teams alone ships as `ms-teams.exe`, `Teams.exe` and
`msteams.exe` across builds, browsers hand audio to differently named child
processes, and every corporate VDI client is its own binary.

So ANY process holding the microphone is a candidate, except a short
not-a-meeting deny list (`detect.NOT_A_MEETING`) and the agent's own PID. The
failure mode flips from "miss the meeting silently" to "record something you can
discard in one click". Known apps are still recognised and reported as such.

If a real call is not detected, run this and join the call:

```powershell
.\.venv\Scripts\python.exe -m meeting_agent.diagnose --watch
```

It prints every change in what is holding the microphone and what the detector
concluded, so a miss takes seconds to diagnose instead of being guessed at from
an empty Meetings page afterwards.

## What it produces

```
server/data/audio/<meeting-id>/utt-000000-system.wav   16 kHz mono 16-bit
                              /utt-000001-mic.wav
```

`system` is everyone else (WASAPI loopback), `mic` is you. Recording them
separately means the local speaker is known with no machine learning at all, so
speaker diarization later only has to split the remote track. VAD means only
speech is written, so storage scales with talking rather than with wall clock.

Audio is deleted when you confirm the transcript on the Meetings page — and the
deletion is verified against the filesystem, so a file Windows refused to remove
is reported rather than assumed gone.

## Model choice, measured on this machine

8 cores, no GPU, int8, `cpu_threads=6`:

| model | RTF | fixed cost per call | domain words |
|---|---|---|---|
| `tiny.en` | 25.5x | 0.39s | wrote "Full filament" for "fulfilment" |
| **`base.en`** (live) | **12.6x** | **0.75s** | correct |
| `small.en` | 3.8x | 2.87s | correct, no measurable gain over base.en |

The fixed cost is the number that matters, and it is not obvious: **Whisper pads
every input to a 30-second window**, so a 3.7s utterance and a 15.6s utterance
cost almost the same (small.en: 2.87s vs 3.49s). Short utterances are therefore
disproportionately expensive, and an RTF measured on long files badly overstates
what a VAD-chunked meeting will achieve.

`small.en` costs 2.5x more than `base.en` for no measurable quality gain here,
so `base.en` is the live pass. Under load it has been measured at **3.4-5.6x**
on real captured utterances, which is comfortable headroom. `tiny.en` is where
the auto-downgrade goes when the backlog passes 30 seconds - it is faster and
measurably worse, and the app says so on screen when it happens.

## Things measured here, not assumed

- **Silero v5 needs 576 samples, not 512.** A 512-sample frame with 64 samples
  of the previous frame prepended. The ONNX input shape is `[None, None]`, so a
  bare 512 is accepted, raises nothing, and returns ~0.001 for everything —
  including real speech. Measured on the fixture: 0/243 frames detected at 512,
  190/243 at 576. `selftest` locks this in, because nothing else would catch it.
- **The two devices disagree.** On this machine the loopback runs at 48000 Hz
  and the microphone at 44100 Hz. 48000 divides into 16000 exactly; 44100 does
  not, so the resampler is a stateful low-pass plus interpolation that carries
  its filter tail and fractional phase across chunk boundaries. Resampling each
  chunk independently leaves a click at every boundary, which a speech model
  reads as a consonant.
- **pycaw is inconsistent.** `GetSpeakers()` returns a wrapped `AudioDevice`
  with no `.Activate`; `GetMicrophone()` returns a raw IMMDevice. Going through
  `GetDeviceEnumerator().GetDefaultAudioEndpoint()` gives a raw device for both.
  And `GetSession(i)` yields an `IAudioSessionControl` with no `GetProcessId` —
  it must be QueryInterface'd to `IAudioSessionControl2`.
- **The vocabulary prompt is harmful on near-silent audio.** It is free on real
  speech (3.04s clip: 0.66s -> 0.74s) and fixes domain words like "cost centre".
  On a 0.38s clip at rms 0.014 it took **11.39s instead of 0.61s** - an 18x
  stall - because the model tries to continue the prompt, produces garbage,
  fails Whisper's compression-ratio check and re-runs the entire temperature
  fallback ladder. A live meeting is full of quiet bleed like that, so the
  prompt is now applied only above a duration and loudness floor.
- **Whisper hallucinates stock phrases on silence.** Two real speaker-bleed
  utterances at rms 0.008 and 0.011 both transcribed as the single word "You".
  Left alone that enters the transcript attributed to a track, so it reads as
  something the user actually said. Gated on level and word count, so a genuine
  "you" in audible speech is untouched.
- **A WASAPI loopback stream delivers NOTHING while the speakers are silent.**
  Measured: 0 callbacks in 4 seconds on a silent loopback device. With blocking
  reads this is fatal - `stream.read()` never returns, the capture thread never
  sees the stop flag, and `pa.terminate()` then deadlocks or segfaults against a
  stream that thread still owns. Observed on a real auto-detected meeting: the
  agent printed "stopping", hung, stopped heartbeating and never posted /end, so
  the meeting stayed `recording` forever and no transcript appeared. Both streams
  now run in CALLBACK mode; stop went from hanging forever to 0.20s.
- **The two tracks therefore have different clocks.** A microphone delivers
  samples continuously, silence included; a loopback does not. Counting elapsed
  time from samples received makes the system track's clock stop during every
  pause, so the two tracks drift apart and the merged transcript interleaves
  wrongly - further out the longer the meeting runs. Timestamps are anchored to
  the wall clock at buffer arrival, with an explicit gap check that also closes
  any open utterance.
- **Whisper invents sentences from room noise, and its own confidence signals
  say so.** A microphone in a quiet room picks up a fan and breathing; Silero
  calls that speech, and Whisper turns 0.35s of hum into "I'm not sure if I'm
  going to do that anymore." Nothing about the text gives it away. The signals
  do, and the separation is not marginal - measured on one recording:

  | | `no_speech_prob` | `avg_logprob` | chars/sec |
  |---|---|---|---|
  | real speech | 0.000 | -0.15..-0.35 | 16-17 |
  | hallucinated | 0.21..0.58 | -0.95..-1.56 | 6..128 |

  All three are checked. A discarded transcript records WHY, so the page shows
  "avg_logprob -1.38 < -0.80" rather than an empty cell that reads as silence.
- **COM must be in the MULTI-THREADED apartment, and every COM pointer must be
  released explicitly.** The agent ran cleanly for exactly 60 seconds, twice,
  then printed `Exception ignored while calling deallocator
  _compointer_base.__del__ / OSError: access violation` at a different address
  each run. Sixty seconds is when Python's generational collector first sweeps
  gen-2, and gen-2 is where COM pointers land when a traceback captures the
  frame holding them — which enumerating audio sessions does routinely, since
  the system-sounds session has no process id. Under the default STA those
  pointers have thread affinity and the collector eventually frees one from the
  wrong thread. Two changes fix it: `sys.coinit_flags = 0` in `__init__.py`
  BEFORE comtypes is imported, and a `finally` that nulls every COM local so a
  lingering traceback holds nothing that still needs releasing. `selftest`
  check [6] asserts both.
- **Encoding and posting must not happen on an audio thread.** WASAPI delivers
  buffers on a schedule; a thread that stops for disk or network I/O misses the
  next one and that audio is gone. A bounded queue separates them, and a full
  queue is reported loudly rather than dropping utterances quietly.

## Environment overrides

`NHA_STT_MODEL`, `NHA_STT_PORT`, `NHA_STT_THREADS`, `NHA_STT_URL` (read by the
Node server), `NHA_SERVER`, `NHA_VAD_THRESHOLD`, `NHA_HANGOVER_MS`, `NHA_PREROLL_MS`,
`NHA_MAX_UTTERANCE_MS`, `NHA_MIN_UTTERANCE_MS`, `NHA_STOP_AFTER_S`,
`NHA_DETECT_POLL_S` — see `meeting_agent/config.py`.

`NHA_MEETING_PYTHON` (read by the Node server) overrides which interpreter the
app spawns. Without it the server uses `meeting-agent/.venv` and **refuses** if
that is missing rather than falling back to a `python` on PATH — the
dependencies are not installed there, so the fallback would be a
`ModuleNotFoundError` several seconds after a button press, attributed to
nothing. When the server starts the agent it also sets `NHA_SERVER` to its own
port, so the two cannot disagree by coincidence.
