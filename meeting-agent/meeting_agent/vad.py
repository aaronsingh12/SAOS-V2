"""
Voice activity detection — the thing that decides where an utterance ends.

This is the most consequential component in the capture agent, because Whisper
is NOT a streaming model. It is trained on windows of up to 30 s and it has to
be handed complete chunks. Cutting the stream on a fixed timer splits words in
half and makes the model hallucinate across the seam; cutting it on silence
produces exactly the 2-15 s natural utterances it handles best, and gives every
later stage a sentence-shaped unit to attach evidence to.

Silero is used through onnxruntime rather than the `silero-vad` pip package,
because that package depends on PyTorch — 2+ GB of wheels for a 2 MB model, on
a machine that has no GPU to justify it.

The model signature is PROBED, not assumed: v5 takes a single `state` tensor
while v4 took separate `h` and `c`. Both are handled by reading the session's
own input names, so a model swap does not silently produce garbage
probabilities that would read as "nobody spoke".
"""
import os

import numpy as np

from . import config

MODEL_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "models", "silero_vad.onnx")
MODEL_URL = "https://raw.githubusercontent.com/snakers4/silero-vad/master/src/silero_vad/data/silero_vad.onnx"


class EnergyVad:
    """
    The fallback, and it is deliberately NOT silent about being the fallback.

    An RMS gate cannot tell speech from a fan, a keyboard or a door. It is good
    enough to keep the agent working when the model is missing, and it is bad
    enough that the user must know it is what they are running — so the name is
    reported to the server, shown on the Meetings page, and printed at startup.
    """

    name = "energy (degraded)"

    def __init__(self, threshold: float = 0.012):
        self.threshold = threshold

    def reset(self):
        pass

    def speech_prob(self, frame: np.ndarray) -> float:
        level = float(np.sqrt(np.mean(np.square(frame, dtype=np.float64)))) if frame.size else 0.0
        return min(1.0, level / self.threshold) if self.threshold > 0 else 0.0


class SileroVad:
    name = "silero-v5"

    def __init__(self, path: str = MODEL_PATH):
        import onnxruntime as ort

        opts = ort.SessionOptions()
        # One thread. The live transcription pass in phase 2 needs the cores far
        # more than a 2 MB model does, and VAD at 32 ms/frame is not the
        # bottleneck on any machine.
        opts.inter_op_num_threads = 1
        opts.intra_op_num_threads = 1
        self.sess = ort.InferenceSession(path, sess_options=opts, providers=["CPUExecutionProvider"])
        self.inputs = {i.name for i in self.sess.get_inputs()}
        self.v5 = "state" in self.inputs
        if not self.v5 and not {"h", "c"} <= self.inputs:
            raise RuntimeError(
                f"Unrecognised Silero VAD signature: inputs are {sorted(self.inputs)}. "
                "Expected v5 (input, state, sr) or v4 (input, h, c, sr)."
            )
        self.reset()

    # MEASURED, and the reason this class exists rather than three inline calls.
    #
    # Silero v5 does NOT take a bare 512-sample frame. Its reference wrapper
    # prepends 64 samples of the PREVIOUS frame as context, so the tensor the
    # model actually wants is 576 long. The ONNX input shape is [None, None],
    # so feeding it 512 is accepted without an error and returns a probability
    # of ~0.001 for everything — real speech included.
    #
    # That failure is invisible: it does not throw, it does not warn, and its
    # output is a perfectly well-formed number meaning "silence". Verified
    # against Windows TTS speech: 0/243 frames detected at 512, 141/243 at 576.
    CONTEXT = 64

    def reset(self):
        self.context = np.zeros((1, self.CONTEXT), dtype=np.float32)
        if self.v5:
            self.state = np.zeros((2, 1, 128), dtype=np.float32)
        else:
            self.h = np.zeros((2, 1, 64), dtype=np.float32)
            self.c = np.zeros((2, 1, 64), dtype=np.float32)

    def speech_prob(self, frame: np.ndarray) -> float:
        f = frame.reshape(1, -1).astype(np.float32)
        sr = np.array(config.SAMPLE_RATE, dtype=np.int64)
        if self.v5:
            x = np.concatenate((self.context, f), axis=1)
            out, self.state = self.sess.run(None, {"input": x, "state": self.state, "sr": sr})
            self.context = f[:, -self.CONTEXT:].copy()
        else:
            out, self.h, self.c = self.sess.run(None, {"input": f, "h": self.h, "c": self.c, "sr": sr})
        return float(np.asarray(out).ravel()[0])


def ensure_model(path: str = MODEL_PATH) -> bool:
    """Fetch the model once. Returns whether it is present afterwards."""
    if os.path.exists(path):
        return True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    try:
        import urllib.request
        urllib.request.urlretrieve(MODEL_URL, path)
        return os.path.exists(path)
    except Exception:
        return False


def load_vad():
    """Silero when it can be loaded, the energy gate when it cannot — and the
    reason is returned rather than swallowed, so the caller can say it out loud."""
    if ensure_model():
        try:
            return SileroVad(), None
        except Exception as err:
            return EnergyVad(), f"Silero failed to load ({err}); falling back to an energy gate."
    return EnergyVad(), (
        f"The Silero VAD model is not present at {MODEL_PATH} and could not be downloaded. "
        "Falling back to an energy gate, which cannot tell speech from a fan or a keyboard."
    )
