"""Every tunable in one place, overridable from the environment."""
import os

SERVER = os.environ.get("NHA_SERVER", "http://127.0.0.1:4000")

# The transcription target. 16 kHz mono is what Whisper wants, and resampling
# once here means every later stage gets one canonical format.
SAMPLE_RATE = 16000
SAMPLE_WIDTH = 2  # int16

# --- Voice activity -------------------------------------------------------
# Silero operates on fixed 512-sample frames at 16 kHz (32 ms).
VAD_FRAME = 512
VAD_THRESHOLD = float(os.environ.get("NHA_VAD_THRESHOLD", "0.5"))

# How much silence closes an utterance. 600 ms is long enough to survive the
# pause inside a sentence and short enough that text appears while the thought
# is still current.
HANGOVER_MS = int(os.environ.get("NHA_HANGOVER_MS", "600"))

# Audio kept from BEFORE speech was detected. Without it the VAD's own reaction
# time clips the first consonant off every utterance, and "can we" becomes
# "an we" in a transcript nobody can then trust.
PREROLL_MS = int(os.environ.get("NHA_PREROLL_MS", "300"))

# Whisper's window is 30 s. An utterance is force-closed before it, at the
# quietest point found, so a monologue still produces transcribable chunks.
MAX_UTTERANCE_MS = int(os.environ.get("NHA_MAX_UTTERANCE_MS", "25000"))
MIN_UTTERANCE_MS = int(os.environ.get("NHA_MIN_UTTERANCE_MS", "250"))

# --- Meeting detection ----------------------------------------------------
# The signal is a process holding an ACTIVE session on the CAPTURE endpoint.
# Spotify, YouTube and Netflix open the speakers and never the microphone, so
# the capture endpoint is what separates a meeting from music.
MEETING_PROCESSES = {
    "ms-teams.exe", "teams.exe", "zoom.exe", "cpthost.exe", "webexmta.exe",
    "webex.exe", "slack.exe", "discord.exe", "chrome.exe", "msedge.exe",
    "firefox.exe", "brave.exe", "gotomeeting.exe", "bluejeans.exe",
    "skype.exe", "lync.exe", "outlook.exe",
}

DETECT_POLL_S = float(os.environ.get("NHA_DETECT_POLL_S", "1.0"))
# How long the meeting signal must be GONE before the meeting is closed. Long
# enough to survive a device switch or a brief mute; short enough that the
# transcript is ready when someone hangs up.
STOP_AFTER_S = float(os.environ.get("NHA_STOP_AFTER_S", "30"))
HEARTBEAT_S = 5.0
