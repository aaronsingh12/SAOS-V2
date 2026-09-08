"""NowHelpAssist capture agent."""

# COM MUST BE PUT IN THE MULTI-THREADED APARTMENT BEFORE comtypes IS IMPORTED.
#
# `comtypes` reads `sys.coinit_flags` at import time and initialises the
# process's COM apartment from it. The default is 2 (COINIT_APARTMENTTHREADED,
# i.e. an STA), and an STA gives every COM object THREAD AFFINITY: it may only
# be released on the thread that created it, and that release is delivered
# through a window message pump this agent does not have.
#
# That matters because Python does not decide when a COM pointer is released —
# the garbage collector does, on whatever thread happens to trigger a
# collection. Measured on this machine, twice, the agent ran cleanly for
# exactly 60 seconds and then printed:
#
#   Exception ignored while calling deallocator _compointer_base.__del__
#   OSError: exception: access violation writing 0x0000000000000024
#
# Sixty seconds is when Python's generational collector first sweeps gen-2,
# which is where COM pointers end up when they are captured in a traceback
# (see detect.py). The faulting address differed between runs, which is the
# signature of a use-after-free rather than a fixed bad pointer.
#
# In the MTA there is no thread affinity, so a release from any thread at any
# time is valid. This line is the whole fix for that class, and it has to be
# here, above every other import, because `meeting_agent/__init__.py` is what
# Python executes first for any `meeting_agent.*` import.
import sys as _sys

_sys.coinit_flags = 0  # COINIT_MULTITHREADED

__version__ = "0.1.1"
