"""Static server for the Image Wall dev preview.

Reads the port from the PORT environment variable so the preview harness
can assign a free port (several chats may serve this folder at once).
Falls back to 8137 when PORT is not set.
"""

import os
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class Handler(SimpleHTTPRequestHandler):
    def end_headers(self):
        # The app is a static page; keep the browser from caching during dev.
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):
        pass  # keep the preview console quiet


def main():
    # The preview harness hands the chosen port over in the environment.
    # Print what we can see so a mismatch is obvious in the server log.
    print("env PORT=%r" % os.environ.get("PORT"), flush=True)
    port = int(os.environ.get("PORT", "8137"))
    handler = partial(Handler, directory=os.path.dirname(os.path.abspath(__file__)))
    with ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"Image Wall serving on http://127.0.0.1:{port}", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
