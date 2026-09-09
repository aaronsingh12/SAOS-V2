"""
The NHA server is the only thing this agent talks to.

Audio bytes never go over HTTP. Both processes are on the same machine, so the
agent writes the WAV and posts the PATH - which is cheaper, keeps the server's
JSON body limit irrelevant, lets anyone play a single utterance back while
debugging, and makes retention a directory removal instead of a row sweep.

The server owns the layout: it returns `audioDir` when a meeting is opened, and
the agent writes only there. A path outside it is rejected server-side.
"""
import json
import urllib.error
import urllib.request

from . import config


class ServerError(Exception):
    pass


class Client:
    def __init__(self, base=None, timeout=10.0):
        self.base = (base or config.SERVER).rstrip("/")
        self.timeout = timeout

    def _call(self, method, path, payload=None):
        url = "{}/api/meetings{}".format(self.base, path)
        data = None
        headers = {}
        if payload is not None:
            data = json.dumps(payload).encode("utf-8")
            headers["Content-Type"] = "application/json"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(req, timeout=self.timeout) as r:
                body = r.read().decode("utf-8")
                return json.loads(body) if body else None
        except urllib.error.HTTPError as err:
            detail = err.read().decode("utf-8", "replace")[:400]
            raise ServerError("{} {} -> {} {}".format(method, path, err.code, detail)) from None
        except urllib.error.URLError as err:
            raise ServerError(
                "cannot reach the NowHelpAssist server at {} ({}). "
                "Start it with `npm run dev` in the project root.".format(self.base, err.reason)
            ) from None

    def heartbeat(self, **state):
        return self._call("POST", "/agent/heartbeat", state)

    def start_meeting(self, **meta):
        """Returns {id, audioDir, started, instance} - audioDir is where to write."""
        return self._call("POST", "/", meta)

    def post_segment(self, meeting_id, segment):
        return self._call("POST", "/{}/segment".format(meeting_id), segment)

    def end_meeting(self, meeting_id):
        return self._call("POST", "/{}/end".format(meeting_id), {})
