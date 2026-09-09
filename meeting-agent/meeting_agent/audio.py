"""
Format conversion into the one canonical shape: 16 kHz mono float32.

The two devices on this machine do not agree with each other or with Whisper:
the loopback runs at 48000 Hz stereo and the microphone at 44100 Hz stereo.
48000 divides into 16000 exactly; 44100 does not, and that is the whole reason
this file is more than three lines.

Both resamplers are STATEFUL, and that is the load-bearing part. Resampling
each 100 ms chunk independently leaves a discontinuity at every chunk boundary
— ten audible clicks per second, which a person barely notices and a speech
model reads as consonants. The filter tail and the fractional read position are
therefore carried across calls.
"""
import hashlib
import math
import struct
import wave

import numpy as np

from . import config


def _lowpass_kernel(cutoff_norm: float, taps: int = 63) -> np.ndarray:
    """Windowed-sinc low-pass. `cutoff_norm` is cycles/sample (0 .. 0.5)."""
    n = np.arange(taps) - (taps - 1) / 2.0
    h = np.sinc(2 * cutoff_norm * n) * np.hamming(taps)
    return (h / h.sum()).astype(np.float32)


class Resampler:
    """One per track. Feed it mono float32; get mono float32 at 16 kHz."""

    def __init__(self, src_rate: int, dst_rate: int = config.SAMPLE_RATE, taps: int = 63):
        self.src_rate = src_rate
        self.dst_rate = dst_rate
        self.ratio = src_rate / dst_rate
        self.passthrough = src_rate == dst_rate
        # An integer ratio is both simpler and better: averaging exactly `f`
        # samples IS the anti-alias filter, with no phase juggling at all.
        self.factor = src_rate // dst_rate if (not self.passthrough and src_rate % dst_rate == 0) else None
        self.taps = taps
        self.h = None if (self.passthrough or self.factor) else _lowpass_kernel(0.45 * dst_rate / src_rate, taps)
        self.carry = np.zeros(0, dtype=np.float32)   # integer path: leftover samples
        self.tail = np.zeros(0, dtype=np.float32)    # filter path: previous samples
        self.phase = 0.0                             # filter path: fractional read position

    def process(self, x: np.ndarray) -> np.ndarray:
        if x.size == 0:
            return x
        if self.passthrough:
            return x
        if self.factor:
            buf = np.concatenate((self.carry, x)) if self.carry.size else x
            n = (buf.size // self.factor) * self.factor
            self.carry = buf[n:].copy()
            if n == 0:
                return np.zeros(0, dtype=np.float32)
            return buf[:n].reshape(-1, self.factor).mean(axis=1).astype(np.float32)

        # Non-integer: low-pass with a carried tail, then linear interpolation
        # at a phase that survives the chunk boundary.
        buf = np.concatenate((self.tail, x)) if self.tail.size else x
        if buf.size < self.taps:
            self.tail = buf.copy()
            return np.zeros(0, dtype=np.float32)
        y = np.convolve(buf, self.h, mode="valid").astype(np.float32)
        self.tail = buf[-(self.taps - 1):].copy()

        if y.size < 2:
            self.phase = max(0.0, self.phase - y.size)
            return np.zeros(0, dtype=np.float32)

        span = y.size - 1
        count = int(math.ceil((span - self.phase) / self.ratio)) if span > self.phase else 0
        if count <= 0:
            self.phase -= y.size
            return np.zeros(0, dtype=np.float32)
        pos = self.phase + np.arange(count, dtype=np.float64) * self.ratio
        pos = pos[pos <= span]
        if pos.size == 0:
            self.phase -= y.size
            return np.zeros(0, dtype=np.float32)
        i0 = np.floor(pos).astype(np.int64)
        frac = (pos - i0).astype(np.float32)
        i1 = np.minimum(i0 + 1, span)
        out = (y[i0] * (1.0 - frac) + y[i1] * frac).astype(np.float32)
        self.phase = float(pos[-1] + self.ratio - y.size)
        return out


def to_mono_float32(raw: bytes, channels: int) -> np.ndarray:
    """int16 interleaved bytes -> mono float32 in [-1, 1]."""
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        usable = (a.size // channels) * channels
        a = a[:usable].reshape(-1, channels).mean(axis=1)
    return a


def rms(x: np.ndarray) -> float:
    """Loudness of an utterance, stored so a silent capture is visible as one."""
    if x.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(x, dtype=np.float64))))


def write_wav(path: str, samples: np.ndarray, rate: int = config.SAMPLE_RATE) -> int:
    """Write mono 16-bit PCM and return the byte count actually on disk."""
    clipped = np.clip(samples, -1.0, 1.0)
    pcm = (clipped * 32767.0).astype(np.int16)
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(config.SAMPLE_WIDTH)
        w.setframerate(rate)
        w.writeframes(pcm.tobytes())
    return 44 + pcm.nbytes  # canonical WAV header + data


def sha256_of(path: str) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(65536), b""):
            h.update(block)
    return h.hexdigest()
