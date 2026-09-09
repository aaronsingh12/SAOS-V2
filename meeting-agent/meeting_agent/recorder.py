"""
Capture -> utterances. Two tracks, one clock, one index sequence.

WHY TWO TRACKS. The microphone is this user; the WASAPI loopback is everyone
else. Recording them separately means the local speaker is known with zero
inference and zero machine learning, so speaker diarization later only ever has
to split the remote track. It costs almost nothing: VAD means we pay for speech
rather than wall clock, and two people rarely talk at once.

TWO MEASURED PROPERTIES OF WASAPI LOOPBACK SHAPE THIS WHOLE FILE.

  (1) A LOOPBACK STREAM DELIVERS NOTHING WHILE THE SPEAKERS ARE SILENT.
      Measured: a callback stream on a silent loopback device fired 0 callbacks
      in 4 seconds. Windows only produces loopback buffers while audio is
      actually rendering.

      With BLOCKING reads that is fatal. `stream.read()` never returns, the
      capture thread never sees the stop flag, `pa.terminate()` is then called
      against a stream a stuck thread still owns, and the process deadlocks or
      segfaults. Measured on a real auto-detected meeting: the agent printed
      "stopping", hung, stopped heartbeating, and never posted /end - so the
      meeting stayed `recording` forever and no transcript ever appeared.

      So both streams run in CALLBACK mode. Nothing ever blocks on audio, and
      shutdown is deterministic: stop_stream + close measured at 0.02s,
      terminate at 0.00s.

  (2) THE TWO TRACKS THEREFORE HAVE DIFFERENT CLOCKS.
      A microphone is a real capture device and delivers samples continuously,
      silence included. The loopback does not. Counting elapsed time from
      samples received - which is the obvious implementation - makes the system
      track's clock STOP during every pause, so its timestamps drift further
      and further behind the microphone's as a meeting goes on, and the merged
      transcript interleaves wrongly.

      Timestamps are therefore anchored to the WALL CLOCK at the moment each
      buffer arrives, with an explicit gap check. A gap also closes any open
      utterance, because audio either side of a silence is not one sentence.
"""
import os
import queue
import threading
import time

import numpy as np
import pyaudiowpatch as pyaudio

from . import config
from .audio import Resampler, rms, sha256_of, to_mono_float32, write_wav
from .vad import load_vad

FRAME = config.VAD_FRAME
_MS = config.SAMPLE_RATE / 1000.0
FRAME_MS = FRAME / _MS

# A jump larger than this between where our clock is and where an arriving
# buffer says it should be means the device stopped delivering - i.e. silence on
# a loopback stream. Comfortably above normal scheduling jitter.
GAP_MS = 150.0


class Segmenter:
    """
    The state machine that decides where an utterance starts and ends.

    Pure and synchronous on purpose: it takes samples and calls back with closed
    utterances, so it can be tested against a WAV file with no audio device, no
    threads and no server.
    """

    def __init__(self, vad, on_utterance, offset_ms=0):
        self.vad = vad
        self.on_utterance = on_utterance
        self.offset_ms = offset_ms
        self.buf = np.zeros(0, dtype=np.float32)
        # Meeting-relative time of the NEXT frame to be consumed. Advanced one
        # frame at a time, and re-anchored whenever a device gap is detected.
        self.next_frame_ms = float(offset_ms)
        self.speaking = False
        self.voiced = []
        self.preroll = []
        self.silence_run = 0
        self.start_ms = 0.0
        self.preroll_frames = max(1, int(config.PREROLL_MS * _MS) // FRAME)
        self.hangover_frames = max(1, int(config.HANGOVER_MS * _MS) // FRAME)
        self.max_frames = max(1, int(config.MAX_UTTERANCE_MS * _MS) // FRAME)

    def feed(self, samples, chunk_end_ms=None):
        """Feed 16 kHz mono float32.

        `chunk_end_ms` is the meeting-relative time of the LAST sample in this
        chunk, taken from the wall clock when the buffer arrived. Passing None
        keeps the old sample-counted behaviour, which is what the offline
        self-test wants when it feeds a file with no gaps.
        """
        if samples.size and chunk_end_ms is not None:
            chunk_start_ms = chunk_end_ms - samples.size / _MS
            # Where our clock says the arriving data SHOULD start: the next
            # frame, plus whatever partial frame is still buffered from the
            # previous chunk. Comparing against `next_frame_ms` alone was the
            # bug the gap regression test caught — there is almost always a
            # leftover partial frame, so the gap was never detected and the
            # timeline silently collapsed.
            expected_ms = self.next_frame_ms + self.buf.size / _MS
            if chunk_start_ms > expected_ms + GAP_MS:
                # The device stopped delivering. On a loopback stream that is
                # silence, and silence either side is not one sentence.
                if self.speaking:
                    self._close()
                # The buffered remainder is from before the gap; it is a
                # fragment of a frame that will never be completed by audio
                # that belongs with it.
                self.buf = np.zeros(0, dtype=np.float32)
                self.preroll = []
                self.next_frame_ms = chunk_start_ms
        if samples.size:
            self.buf = np.concatenate((self.buf, samples)) if self.buf.size else samples
        while self.buf.size >= FRAME:
            frame, self.buf = self.buf[:FRAME], self.buf[FRAME:]
            self._frame(frame)
            self.next_frame_ms += FRAME_MS

    def _frame(self, frame):
        p = self.vad.speech_prob(frame)
        is_speech = p > config.VAD_THRESHOLD

        if not self.speaking:
            self.preroll.append(frame)
            if len(self.preroll) > self.preroll_frames:
                self.preroll.pop(0)
            if is_speech:
                # The pre-roll is why the first consonant survives. Without it
                # the VAD's own reaction time clips every utterance's opening.
                self.speaking = True
                self.voiced = list(self.preroll)
                self.start_ms = self.next_frame_ms - (len(self.preroll) - 1) * FRAME_MS
                self.preroll = []
                self.silence_run = 0
            return

        self.voiced.append(frame)
        self.silence_run = 0 if is_speech else self.silence_run + 1

        if self.silence_run >= self.hangover_frames:
            self._close(trim=self.silence_run - 1)
        elif len(self.voiced) >= self.max_frames:
            # Whisper's window is 30 s, so a monologue is cut before it - at
            # the quietest frame in the recent past rather than mid-syllable.
            tail = self.voiced[-self.hangover_frames:]
            quietest = int(np.argmin([float(np.abs(f).mean()) for f in tail]))
            self._close(trim=len(tail) - 1 - quietest)

    def _close(self, trim=0):
        frames = self.voiced[:len(self.voiced) - trim] if trim > 0 else self.voiced
        self.speaking, self.voiced, self.silence_run = False, [], 0
        if not frames:
            return
        audio = np.concatenate(frames)
        dur_ms = int(audio.size / _MS)
        if dur_ms < config.MIN_UTTERANCE_MS:
            return  # a cough or a click, not an utterance
        start = int(max(0.0, self.start_ms))
        self.on_utterance(audio, start, start + dur_ms)

    def flush(self):
        """Close whatever is open - the meeting ended mid-sentence."""
        if self.speaking:
            self._close()


class MeetingRecorder:
    """Owns both device streams, the shared index sequence and the writer."""

    def __init__(self, meeting_id, audio_dir, client, log):
        self.meeting_id = meeting_id
        self.audio_dir = audio_dir
        self.client = client
        self.log = log
        self.pa = pyaudio.PyAudio()
        self.stop_flag = threading.Event()
        self.q = queue.Queue(maxsize=256)
        self.idx_lock = threading.Lock()
        self.next_idx = 0
        self.threads = []
        self.streams = []
        self.t0 = None
        self.counts = {"mic": 0, "system": 0}
        self.dropped = 0
        os.makedirs(audio_dir, exist_ok=True)

    def _claim_idx(self):
        with self.idx_lock:
            i = self.next_idx
            self.next_idx += 1
            return i

    def _devices(self):
        """The two endpoints, probed rather than assumed."""
        out = {}
        try:
            out["system"] = self.pa.get_default_wasapi_loopback()
        except Exception as err:
            self.log("no WASAPI loopback device: {}".format(err))
        try:
            out["mic"] = self.pa.get_default_input_device_info()
        except Exception as err:
            self.log("no input device: {}".format(err))
        return out

    def _open(self, track, info):
        """Open one stream in CALLBACK mode and return its raw-audio queue.

        The callback runs on PortAudio's own thread and must never be slow, so
        it does exactly one thing: stamp the buffer with the wall clock and put
        it on a queue. Everything expensive happens on our thread.
        """
        rate = int(info["defaultSampleRate"])
        channels = min(2, int(info["maxInputChannels"])) or 1
        raw_q = queue.Queue(maxsize=512)

        def callback(in_data, frame_count, time_info, status):
            try:
                raw_q.put_nowait((time.monotonic(), in_data))
            except queue.Full:
                pass  # reported by the processing thread, which can see the gap
            return (None, pyaudio.paContinue)

        stream = self.pa.open(
            format=pyaudio.paInt16, channels=channels, rate=rate,
            input=True, input_device_index=info["index"],
            frames_per_buffer=1024, stream_callback=callback,
        )
        stream.start_stream()
        self.streams.append(stream)
        return stream, raw_q, rate, channels

    def _process(self, track, info):
        try:
            stream, raw_q, rate, channels = self._open(track, info)
        except Exception as err:
            self.log("{}: could not open {!r} - {}".format(track, info["name"], err))
            return

        vad, warn = load_vad()
        if warn:
            self.log("{}: {}".format(track, warn))
        resampler = Resampler(rate, config.SAMPLE_RATE)

        def emit(audio, start_ms, end_ms):
            idx = self._claim_idx()
            try:
                self.q.put_nowait((idx, track, audio, start_ms, end_ms))
            except queue.Full:
                # Loud, never silent: a dropped utterance is a hole in the
                # transcript and the user has to be told it exists.
                self.dropped += 1
                self.log("WRITER QUEUE FULL - utterance {} on {} was DROPPED ({} lost so far). "
                         "Disk or server is too slow.".format(idx, track, self.dropped))

        seg = Segmenter(vad, emit)
        self.log("{}: capturing {!r} {} Hz {}ch -> 16 kHz mono, VAD {}".format(
            track, info["name"], rate, channels, vad.name))

        while not self.stop_flag.is_set():
            try:
                arrived, raw = raw_q.get(timeout=0.2)
            except queue.Empty:
                # Normal on a loopback stream: silence delivers nothing at all.
                continue
            mono = to_mono_float32(raw, channels)
            # Wall-clock time of the last sample in this buffer, meeting-relative.
            end_ms = (arrived - self.t0) * 1000.0
            seg.feed(resampler.process(mono), chunk_end_ms=end_ms)
        seg.flush()

    def _writer(self):
        while True:
            item = self.q.get()
            if item is None:
                self.q.task_done()
                break
            idx, track, audio, start_ms, end_ms = item
            try:
                path = os.path.join(self.audio_dir, "utt-{:06d}-{}.wav".format(idx, track))
                nbytes = write_wav(path, audio)
                self.client.post_segment(self.meeting_id, {
                    "idx": idx, "track": track,
                    "start_ms": start_ms, "end_ms": end_ms,
                    "audio_path": path, "bytes": nbytes,
                    "sha256": sha256_of(path), "rms": rms(audio),
                })
                self.counts[track] += 1
            except Exception as err:
                self.log("utterance {} ({}) could not be stored: {}".format(idx, track, err))
            finally:
                self.q.task_done()

    def start(self):
        self.t0 = time.monotonic()
        devices = self._devices()
        if not devices:
            raise RuntimeError("Neither a microphone nor a loopback device could be opened.")
        w = threading.Thread(target=self._writer, name="writer", daemon=True)
        w.start()
        self.threads.append(w)
        for track, info in devices.items():
            t = threading.Thread(target=self._process, args=(track, info), name=track, daemon=True)
            t.start()
            self.threads.append(t)
        return sorted(devices)

    def stop(self):
        """Shut down in an order that cannot hang.

        Streams are closed FIRST, from this thread. In callback mode that is
        safe and fast, and it guarantees PortAudio is no longer calling into us
        before anything is torn down. Every wait after it is bounded, because
        the whole point of this method is that the agent survives it: a stop
        that hangs takes the detection loop and the heartbeat with it, and the
        meeting is never closed on the server.
        """
        self.stop_flag.set()

        for s in self.streams:
            try:
                s.stop_stream()
                s.close()
            except Exception as err:
                self.log("a capture stream did not close cleanly: {}".format(err))
        self.streams = []

        for t in self.threads:
            if t.name != "writer":
                t.join(timeout=5)
                if t.is_alive():
                    self.log("the {} capture thread did not exit; continuing without it".format(t.name))

        # Drain what is already captured, but never wait forever for it.
        deadline = time.monotonic() + 30
        while self.q.unfinished_tasks and time.monotonic() < deadline:
            time.sleep(0.05)
        if self.q.unfinished_tasks:
            self.log("{} utterance(s) were still being written after 30s and may be missing "
                     "from the transcript".format(self.q.unfinished_tasks))

        try:
            self.q.put_nowait(None)
        except queue.Full:
            pass
        try:
            self.pa.terminate()
        except Exception as err:
            self.log("the audio system did not shut down cleanly: {}".format(err))
        return dict(self.counts), self.dropped
